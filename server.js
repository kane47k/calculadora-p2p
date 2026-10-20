const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8kb' }));
app.disable('x-powered-by');

const BINANCE_ADS_URL = 'https://www.binance.com/bapi/c2c/v1/public/c2c/agent/ad-list';
const BINANCE_TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS || 10000);
const OFFERS_TO_REQUEST = Math.min(20, Math.max(5, Number(process.env.BINANCE_ADS_LIMIT || 20)));
const OFFERS_TO_MEDIAN = Math.min(10, Math.max(3, Number(process.env.BINANCE_OFFERS_TO_MEDIAN || 5)));
const MIN_COMPLETION_RATE = Number(process.env.BINANCE_MIN_COMPLETION_RATE || 90);
const MIN_MONTH_ORDERS = Number(process.env.BINANCE_MIN_MONTH_ORDERS || 20);
const MIN_VALID_OFFERS = Math.max(3, Number(process.env.BINANCE_MIN_VALID_OFFERS || 3));

// Cantidad de referencia en moneda local para no tomar anuncios que no admitan
// una operación de tamaño razonable. Ajusta estos valores en Render al tamaño
// habitual de tus operaciones. No son tasas: son importes fiat de referencia.
const REFERENCE_AMOUNT = {
  VES: Number(process.env.REFERENCE_AMOUNT_VES || 100000),
  COP: Number(process.env.REFERENCE_AMOUNT_COP || 315000)
};

// Opcional: identificadores exactos de métodos de pago de Binance separados por coma.
// Si se dejan vacíos, no se filtra por método de pago porque no conocemos el método
// que utilizarás en cada operación. No introducir nombres visibles; usar identifiers.
const PAYMENT_METHODS = {
  VES: (process.env.BINANCE_PAY_TYPES_VES || '').split(',').map(x => x.trim()).filter(Boolean),
  COP: (process.env.BINANCE_PAY_TYPES_COP || '').split(',').map(x => x.trim()).filter(Boolean)
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  // Binance sometimes serializes percentages as strings such as '98.5%'.
  const normalized = typeof value === 'string' ? value.trim().replace(/%$/, '') : value;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function percent(value) {
  const n = num(value);
  if (n === null) return null;
  return n <= 1 ? n * 100 : n;
}

function first(...values) {
  for (const value of values) {
    const n = num(value);
    if (n !== null) return n;
  }
  return null;
}

function unwrapOffers(payload) {
  const roots = [payload?.data?.data, payload?.data?.list, payload?.data?.items,
    payload?.data?.advList, payload?.data, payload?.list, payload?.items];
  for (const candidate of roots) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      for (const key of ['data', 'list', 'items', 'advList', 'rows']) {
        if (Array.isArray(candidate[key])) return candidate[key];
      }
    }
  }
  return [];
}

function normalizeOffer(item) {
  const adv = item?.adv || item?.advertisement || item?.advDetail || item || {};
  const advertiser = item?.advertiser || item?.user || {};
  const price = first(adv.price, item.price, adv.advPrice);
  const min = first(adv.minSingleTransAmount, adv.minAmount, adv.minLimit,
    item.minSingleTransAmount, item.minAmount, item.minLimit);
  const max = first(adv.maxSingleTransAmount, adv.maxAmount, adv.maxLimit,
    item.maxSingleTransAmount, item.maxAmount, item.maxLimit);
  const completion = percent(advertiser.monthFinishRate ?? advertiser.completionRate ??
    item.monthFinishRate ?? item.completionRate);
  const monthOrders = first(advertiser.monthOrderCount, advertiser.monthFinishCount,
    item.monthOrderCount, item.monthFinishCount);
  const paymentMethods = (adv.tradeMethods || adv.tradeMethodList || item.tradeMethods || [])
    .map(m => String(m.identifier || m.tradeMethodIdentifier || m.payType || '').trim())
    .filter(Boolean);
  return { price, min, max, completion, monthOrders, paymentMethods };
}

async function obtenerTasaBinance(fiat, tradeType) {
  try {
    const payTypes = PAYMENT_METHODS[fiat] || [];
    const params = { fiat, asset: 'USDT', tradeType, limit: OFFERS_TO_REQUEST };
    // El endpoint documenta tradeMethodIdentifiers como parámetro repetible.
    const url = new URL(BINANCE_ADS_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    for (const payType of payTypes) url.searchParams.append('tradeMethodIdentifiers', payType);

    const response = await axios.get(url.toString(), {
      timeout: BINANCE_TIMEOUT_MS,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Remex-LA-P2P/2.0' }
    });
    if (response.data?.success === false || (response.data?.code && response.data.code !== '000000')) {
      throw new Error(`Binance rechazó la consulta (${response.data?.code || 'sin código'})`);
    }

    const referenceAmount = REFERENCE_AMOUNT[fiat];
    const offers = unwrapOffers(response.data).map(normalizeOffer).filter(o => {
      if (!o.price || !o.min || !o.max || o.max < o.min) return false;
      if (referenceAmount > 0 && !(o.min <= referenceAmount && o.max >= referenceAmount)) return false;
      // Fail closed: offers without quality data are not treated as trustworthy.
      if (o.completion === null || o.completion < MIN_COMPLETION_RATE) return false;
      if (o.monthOrders === null || o.monthOrders < MIN_MONTH_ORDERS) return false;
      if (payTypes.length && !payTypes.some(type => o.paymentMethods.includes(type))) return false;
      return true;
    });

    if (offers.length < MIN_VALID_OFFERS) {
      throw new Error(`Solo hay ${offers.length} anuncios válidos para ${fiat}/${tradeType}; se requieren al menos ${MIN_VALID_OFFERS} que acepten ${referenceAmount} ${fiat} y cumplan los filtros de calidad.`);
    }

    // Mejor precio para el usuario que toma el anuncio: BUY (compra USDT) = menor
    // precio; SELL (vende USDT) = mayor precio. Tomamos la mediana de los anuncios
    // más competitivos para reducir el efecto de anuncios extremos.
    offers.sort((a, b) => tradeType === 'BUY' ? a.price - b.price : b.price - a.price);
    const competitive = offers.slice(0, OFFERS_TO_MEDIAN).map(o => o.price).sort((a, b) => a - b);
    const middle = Math.floor(competitive.length / 2);
    const price = competitive.length % 2
      ? competitive[middle]
      : (competitive[middle - 1] + competitive[middle]) / 2;

    return { price, validOffers: offers.length, sampled: competitive.length, referenceAmount };
  } catch (error) {
    console.error(`Error Binance P2P ${fiat}/${tradeType}:`, error.message);
    return null;
  }
}

function tasaFinal(valor) {
  return Number.isFinite(valor) && valor > 0 ? Number(valor.toFixed(2)) : null;
}

app.get('/api/tasas', async (_req, res) => {
  const [vesBuy, vesSell, copBuy, copSell] = await Promise.all([
    obtenerTasaBinance('VES', 'BUY'), obtenerTasaBinance('VES', 'SELL'),
    obtenerTasaBinance('COP', 'BUY'), obtenerTasaBinance('COP', 'SELL')
  ]);
  const tasas = {
    VES_USDT_BUY: tasaFinal(vesBuy?.price),
    VES_USDT_SELL: tasaFinal(vesSell?.price),
    COP_USDT_BUY: tasaFinal(copBuy?.price),
    COP_USDT_SELL: tasaFinal(copSell?.price)
  };
  const enVivo = {
    VES_USDT_BUY: Boolean(vesBuy), VES_USDT_SELL: Boolean(vesSell),
    COP_USDT_BUY: Boolean(copBuy), COP_USDT_SELL: Boolean(copSell)
  };
  const todoEnVivo = Object.values(enVivo).every(Boolean);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const metadata = {
    fuente: 'Binance P2P ad-list',
    criterio: `Mediana de hasta ${OFFERS_TO_MEDIAN} anuncios competitivos; importe dentro de límites, finalización mínima ${MIN_COMPLETION_RATE}%, ${MIN_MONTH_ORDERS} operaciones mensuales mínimas y al menos ${MIN_VALID_OFFERS} anuncios válidos.`,
    importesReferencia: REFERENCE_AMOUNT,
    metodosPagoFiltrados: {
      VES: PAYMENT_METHODS.VES.length ? PAYMENT_METHODS.VES : null,
      COP: PAYMENT_METHODS.COP.length ? PAYMENT_METHODS.COP : null
    },
    anunciosValidos: {
      VES_USDT_BUY: vesBuy?.validOffers || 0,
      VES_USDT_SELL: vesSell?.validOffers || 0,
      COP_USDT_BUY: copBuy?.validOffers || 0,
      COP_USDT_SELL: copSell?.validOffers || 0
    }
  };
  if (!todoEnVivo) {
    return res.status(503).json({ success: false, tasas, enVivo, metadata,
      actualizado: new Date().toISOString(),
      error: 'No se encontraron suficientes anuncios P2P válidos para una o más cotizaciones. No se devuelve una tasa antigua de respaldo.' });
  }
  return res.json({ success: true, tasas, enVivo, metadata, actualizado: new Date().toISOString() });
});

app.get('/health', (_req, res) => res.json({ ok: true, servicio: 'Remex L.A. - Tasas P2P' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de tasas Remex L.A. activo en puerto ${PORT}`));
