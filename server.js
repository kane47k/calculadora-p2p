const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8kb' }));
app.disable('x-powered-by');

const BINANCE_ADS_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const BINANCE_TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS || 10000);
const OFFERS_TO_REQUEST = Math.min(20, Math.max(5, Number(process.env.BINANCE_ADS_LIMIT || 20)));
const OFFERS_TO_MEDIAN = Math.min(10, Math.max(3, Number(process.env.BINANCE_OFFERS_TO_MEDIAN || 5)));
const MIN_COMPLETION_RATE = Number(process.env.BINANCE_MIN_COMPLETION_RATE || 90);
const MIN_MONTH_ORDERS = Number(process.env.BINANCE_MIN_MONTH_ORDERS || 20);
const MIN_VALID_OFFERS = Math.max(1, Number(process.env.BINANCE_MIN_VALID_OFFERS || 3));

const REFERENCE_AMOUNT = {
  VES: Number(process.env.REFERENCE_AMOUNT_VES || 100000),
  COP: Number(process.env.REFERENCE_AMOUNT_COP || 315000)
};

// Configure Binance payment-type identifiers only if you know the exact identifiers.
const PAYMENT_METHODS = {
  VES: (process.env.BINANCE_PAY_TYPES_VES || '').split(',').map(x => x.trim()).filter(Boolean),
  COP: (process.env.BINANCE_PAY_TYPES_COP || '').split(',').map(x => x.trim()).filter(Boolean)
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
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
  const roots = [
    payload?.data?.data, payload?.data?.list, payload?.data?.items,
    payload?.data?.advList, payload?.data?.rows, payload?.data,
    payload?.list, payload?.items, payload?.rows
  ];
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
  const advertiser = item?.advertiser || item?.user || item?.merchant || {};
  const price = first(adv.price, item.price, adv.advPrice);
  const min = first(adv.minSingleTransAmount, adv.minAmount, adv.minLimit,
    adv.minSingleTransQuantity, item.minSingleTransAmount, item.minAmount, item.minLimit);
  const max = first(adv.maxSingleTransAmount, adv.maxAmount, adv.maxLimit,
    adv.maxSingleTransQuantity, item.maxSingleTransAmount, item.maxAmount, item.maxLimit);
  const completion = percent(advertiser.monthFinishRate ?? advertiser.completionRate ??
    advertiser.monthFinishRateText ?? item.monthFinishRate ?? item.completionRate);
  const monthOrders = first(advertiser.monthOrderCount, advertiser.monthFinishCount,
    advertiser.monthOrderCountText, item.monthOrderCount, item.monthFinishCount);
  const rawMethods = adv.tradeMethods || adv.tradeMethodList || adv.payTypes ||
    item.tradeMethods || item.tradeMethodList || item.payTypes || [];
  const paymentMethods = Array.isArray(rawMethods) ? rawMethods.map(m =>
    String(m?.identifier || m?.tradeMethodIdentifier || m?.payType || m?.tradeMethodName || m?.name || '').trim()
  ).filter(Boolean) : [];
  return { price, min, max, completion, monthOrders, paymentMethods };
}

async function obtenerTasaBinance(fiat, tradeType) {
  try {
    const payTypes = PAYMENT_METHODS[fiat] || [];
    const body = {
      fiat,
      page: 1,
      rows: OFFERS_TO_REQUEST,
      tradeType,
      asset: 'USDT',
      countries: [],
      proMerchantAds: false,
      shieldMerchantAds: false,
      publisherType: null,
      payTypes
    };
    const response = await axios.post(BINANCE_ADS_URL, body, {
      timeout: BINANCE_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        'clienttype': 'web'
      }
    });
    const payload = response.data;
    if (payload?.success === false || (payload?.code && payload.code !== '000000')) {
      throw new Error(`Binance rechazó la consulta (${payload?.code || 'sin código'})`);
    }

    const referenceAmount = REFERENCE_AMOUNT[fiat];
    const rawOffers = unwrapOffers(payload);
    const normalized = rawOffers.map(normalizeOffer);
    const offers = normalized.filter(o => {
      if (!o.price || !o.min || !o.max || o.max < o.min) return false;
      if (referenceAmount > 0 && !(o.min <= referenceAmount && o.max >= referenceAmount)) return false;
      // If quality fields are present, enforce the thresholds. Missing quality data
      // remains ineligible so the service never silently trusts an unknown advertiser.
      if (o.completion === null || o.completion < MIN_COMPLETION_RATE) return false;
      if (o.monthOrders === null || o.monthOrders < MIN_MONTH_ORDERS) return false;
      if (payTypes.length && !payTypes.some(type => o.paymentMethods.includes(type))) return false;
      return true;
    });

    if (offers.length < MIN_VALID_OFFERS) {
      console.error(`Binance ${fiat}/${tradeType}: raw=${rawOffers.length}, normalized=${normalized.length}, valid=${offers.length}`);
      throw new Error(`Anuncios válidos insuficientes para ${fiat}/${tradeType} (${offers.length}/${MIN_VALID_OFFERS}).`);
    }

    // BUY: el cliente compra USDT y busca el menor precio fiat/USDT.
    // SELL: el cliente vende USDT y busca el mayor precio fiat/USDT.
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
  const metadata = {
    fuente: 'Binance P2P friendly/c2c/adv/search',
    criterio: `Mediana de hasta ${OFFERS_TO_MEDIAN} anuncios competitivos; importe dentro de límites, finalización mínima ${MIN_COMPLETION_RATE}%, mínimo ${MIN_MONTH_ORDERS} operaciones mensuales y al menos ${MIN_VALID_OFFERS} anuncios válidos.`,
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
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  if (!todoEnVivo) {
    return res.status(503).json({
      success: false, tasas, enVivo, metadata, actualizado: new Date().toISOString(),
      error: 'No se encontraron suficientes anuncios P2P válidos para una o más cotizaciones. No se usa una tasa antigua.'
    });
  }
  return res.json({ success: true, tasas, enVivo, metadata, actualizado: new Date().toISOString() });
});

app.get('/health', (_req, res) => res.json({ ok: true, servicio: 'Remex L.A. - Tasas P2P' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de tasas Remex L.A. activo en puerto ${PORT}`));
