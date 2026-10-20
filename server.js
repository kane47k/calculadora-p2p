'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.disable('x-powered-by');

// Endpoint público usado por la interfaz P2P de Binance. La búsqueda es POST;
// el endpoint antiguo GET /agent/ad-list devolvía resultados incompletos.
const BINANCE_ADS_URL = 'https://www.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const BINANCE_TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS || 12000);
const OFFERS_TO_REQUEST = Math.min(20, Math.max(10, Number(process.env.BINANCE_ADS_LIMIT || 20)));
const OFFERS_TO_MEDIAN = Math.min(10, Math.max(3, Number(process.env.BINANCE_OFFERS_TO_MEDIAN || 5)));
const MIN_COMPLETION_RATE = Number(process.env.BINANCE_MIN_COMPLETION_RATE || 90);
const MIN_MONTH_ORDERS = Number(process.env.BINANCE_MIN_MONTH_ORDERS || 20);
// Dos anuncios de buena calidad permiten calcular mediana sin bloquear una tasa
// solo porque un mercado tenga poca liquidez. Nunca se usa una tasa antigua.
const MIN_VALID_OFFERS = Math.max(2, Number(process.env.BINANCE_MIN_VALID_OFFERS || 2));
const REFERENCE_AMOUNT = {
  VES: Number(process.env.REFERENCE_AMOUNT_VES || 100000),
  COP: Number(process.env.REFERENCE_AMOUNT_COP || 315000)
};
const PAYMENT_METHODS = {
  VES: (process.env.BINANCE_PAY_TYPES_VES || '').split(',').map(x => x.trim()).filter(Boolean),
  COP: (process.env.BINANCE_PAY_TYPES_COP || '').split(',').map(x => x.trim()).filter(Boolean)
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(typeof value === 'string' ? value.trim().replace(/%$/, '') : value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function percent(value) {
  const n = num(value);
  return n === null ? null : (n <= 1 ? n * 100 : n);
}
function first(...values) {
  for (const v of values) { const n = num(v); if (n !== null) return n; }
  return null;
}
function unwrapOffers(payload) {
  const roots = [payload?.data?.data, payload?.data?.list, payload?.data?.items,
    payload?.data?.advList, payload?.data, payload?.list, payload?.items];
  for (const candidate of roots) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      for (const key of ['data', 'list', 'items', 'advList', 'rows'])
        if (Array.isArray(candidate[key])) return candidate[key];
    }
  }
  return [];
}
function normalizeOffer(item) {
  const adv = item?.adv || item?.advertisement || item?.advDetail || item || {};
  const advertiser = item?.advertiser || item?.user || item?.advertiserInfo || {};
  const price = first(adv.price, item.price, adv.advPrice);
  const min = first(adv.minSingleTransAmount, adv.minAmount, adv.minLimit,
    item.minSingleTransAmount, item.minAmount, item.minLimit);
  const max = first(adv.maxSingleTransAmount, adv.maxAmount, adv.maxLimit,
    item.maxSingleTransAmount, item.maxAmount, item.maxLimit);
  const completion = percent(advertiser.monthFinishRate ?? advertiser.completionRate ??
    item.monthFinishRate ?? item.completionRate ?? advertiser.tradeFinishRate);
  const monthOrders = first(advertiser.monthOrderCount, advertiser.monthFinishCount,
    item.monthOrderCount, item.monthFinishCount, advertiser.monthTradeCount);
  const methods = adv.tradeMethods || adv.tradeMethodList || item.tradeMethods || [];
  const paymentMethods = Array.isArray(methods) ? methods.map(m =>
    String(m?.identifier || m?.tradeMethodIdentifier || m?.payType || m?.tradeMethodName || '').trim()
  ).filter(Boolean) : [];
  return { price, min, max, completion, monthOrders, paymentMethods };
}

async function obtenerTasaBinance(fiat, tradeType) {
  const referenceAmount = REFERENCE_AMOUNT[fiat];
  const payTypes = PAYMENT_METHODS[fiat] || [];
  const diagnostic = { raw: 0, valid: 0, rejected: {} };
  try {
    const body = {
      asset: 'USDT', fiat, tradeType, page: 1, rows: OFFERS_TO_REQUEST,
      transAmount: String(referenceAmount), payTypes,
      publisherType: null, merchantCheck: false, countries: [],
      proMerchantAds: false, shieldMerchantAds: false,
      filterType: 'all', periods: [], additionalKycVerifyFilter: 0,
      classifies: ['mass', 'profession']
    };
    const response = await axios.post(BINANCE_ADS_URL, body, {
      timeout: BINANCE_TIMEOUT_MS,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'clienttype': 'web', 'lang': 'en'
      }
    });
    const payload = response.data;
    if (payload?.success === false || (payload?.code && payload.code !== '000000'))
      throw new Error(`Binance rechazó la consulta (${payload?.code || 'sin código'}): ${payload?.message || payload?.msg || 'sin detalle'}`);

    const raw = unwrapOffers(payload);
    diagnostic.raw = raw.length;
    const normalized = raw.map(normalizeOffer);
    const offers = [];
    for (const o of normalized) {
      let reason = '';
      if (!o.price) reason = 'sin_precio';
      else if (o.min === null || o.max === null || o.max < o.min) reason = 'limites_no_disponibles';
      else if (!(o.min <= referenceAmount && o.max >= referenceAmount)) reason = 'importe_fuera_de_limites';
      else if (o.completion === null) reason = 'sin_dato_finalizacion';
      else if (o.completion < MIN_COMPLETION_RATE) reason = 'finalizacion_baja';
      else if (o.monthOrders === null) reason = 'sin_dato_operaciones';
      else if (o.monthOrders < MIN_MONTH_ORDERS) reason = 'pocas_operaciones';
      else if (payTypes.length && !payTypes.some(t => o.paymentMethods.includes(t))) reason = 'metodo_pago_no_coincide';
      if (reason) diagnostic.rejected[reason] = (diagnostic.rejected[reason] || 0) + 1;
      else offers.push(o);
    }
    diagnostic.valid = offers.length;
    console.log(`Binance ${fiat}/${tradeType}: raw=${diagnostic.raw}, valid=${diagnostic.valid}, rechazados=${JSON.stringify(diagnostic.rejected)}`);

    if (offers.length < MIN_VALID_OFFERS) {
      return { ok: false, diagnostic, error: `Solo hay ${offers.length} anuncios válidos para ${fiat}/${tradeType}; se requieren ${MIN_VALID_OFFERS}.` };
    }
    // Precio competitivo: comprar USDT usa los anuncios más baratos; vender USDT,
    // los más caros. La mediana evita depender de un único anuncio extremo.
    offers.sort((a, b) => tradeType === 'BUY' ? a.price - b.price : b.price - a.price);
    const sample = offers.slice(0, OFFERS_TO_MEDIAN).map(o => o.price).sort((a, b) => a - b);
    const mid = Math.floor(sample.length / 2);
    const price = sample.length % 2 ? sample[mid] : (sample[mid - 1] + sample[mid]) / 2;
    return { ok: true, price, validOffers: offers.length, sampled: sample.length, referenceAmount, diagnostic };
  } catch (error) {
    console.error(`Error Binance P2P ${fiat}/${tradeType}: ${error.message}`);
    return { ok: false, diagnostic, error: error.message };
  }
}
function tasaFinal(value) {
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
}

app.get('/api/tasas', async (_req, res) => {
  const [vesBuy, vesSell, copBuy, copSell] = await Promise.all([
    obtenerTasaBinance('VES', 'BUY'), obtenerTasaBinance('VES', 'SELL'),
    obtenerTasaBinance('COP', 'BUY'), obtenerTasaBinance('COP', 'SELL')
  ]);
  const results = { VES_USDT_BUY: vesBuy, VES_USDT_SELL: vesSell, COP_USDT_BUY: copBuy, COP_USDT_SELL: copSell };
  const tasas = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, tasaFinal(v?.price)]));
  const enVivo = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Boolean(v?.ok && tasas[k] !== null)]));
  const todoEnVivo = Object.values(enVivo).every(Boolean);
  const metadata = {
    fuente: 'Binance P2P public adv/search',
    criterio: `Mediana de hasta ${OFFERS_TO_MEDIAN} anuncios competitivos; importe de referencia, finalización mínima ${MIN_COMPLETION_RATE}%, mínimo ${MIN_MONTH_ORDERS} operaciones mensuales y al menos ${MIN_VALID_OFFERS} anuncios válidos.`,
    importesReferencia: REFERENCE_AMOUNT,
    metodosPagoFiltrados: { VES: PAYMENT_METHODS.VES.length ? PAYMENT_METHODS.VES : null, COP: PAYMENT_METHODS.COP.length ? PAYMENT_METHODS.COP : null },
    anunciosValidos: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v?.diagnostic?.valid || 0])),
    diagnostico: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v?.diagnostic || null]))
  };
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const actualizado = new Date().toISOString();
  if (!todoEnVivo) {
    return res.status(503).json({ success: false, tasas, enVivo, metadata, actualizado,
      error: 'Una o más cotizaciones no están disponibles en Binance P2P. No se usa una tasa antigua.',
      errores: Object.fromEntries(Object.entries(results).filter(([, v]) => !v?.ok).map(([k, v]) => [k, v?.error || 'Cotización no disponible'])) });
  }
  return res.json({ success: true, tasas, enVivo, metadata, actualizado });
});
app.get('/health', (_req, res) => res.json({ ok: true, servicio: 'Remex L.A. - Tasas P2P' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de tasas Remex L.A. activo en puerto ${PORT}`));
