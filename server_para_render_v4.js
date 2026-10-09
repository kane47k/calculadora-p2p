const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8kb' }));
app.disable('x-powered-by');

const BINANCE_QUOTE_URL = 'https://www.binance.com/bapi/c2c/v1/public/c2c/agent/quote-price';
const REMITLY_RATE_TTL_MS = Number(process.env.REMITLY_RATE_TTL_MS || 30 * 60 * 1000);
const ADMIN_RATE_TOKEN = process.env.ADMIN_RATE_TOKEN || '';

// A Remitly rate is only trusted for quotes after it is verified against the user's
// actual Remitly quote (US -> Colombia, Nequi, debit card, matching amount/conditions).
// There is no public unauthenticated endpoint guaranteed to return that personalized quote.
let verifiedRemitlyRate = null;
let verifiedRemitlyAt = null;
const envRate = Number(process.env.REMITLY_USD_COP_RATE);
const envRateAt = process.env.REMITLY_RATE_VERIFIED_AT;
if (Number.isFinite(envRate) && envRate > 0 && envRateAt && Number.isFinite(Date.parse(envRateAt))) {
  verifiedRemitlyRate = envRate;
  verifiedRemitlyAt = new Date(envRateAt).toISOString();
}

function extraerPrecio(data) {
  const candidatos = [data?.data?.price, data?.data?.quotePrice, data?.data?.bestPrice,
    data?.price, data?.quotePrice, data?.bestPrice];
  for (const valor of candidatos) {
    const numero = Number(valor);
    if (Number.isFinite(numero) && numero > 0) return numero;
  }
  return null;
}

async function obtenerTasaBinance(fiat, tradeType) {
  try {
    const response = await axios.get(BINANCE_QUOTE_URL, {
      params: { fiat, asset: 'USDT', tradeType }, timeout: 10000,
      headers: { Accept: 'application/json', 'User-Agent': 'Remex-LA-P2P/1.0' }
    });
    const precio = extraerPrecio(response.data);
    if (!precio) throw new Error(`Binance no devolvió precio para ${fiat}/${tradeType}`);
    return precio;
  } catch (error) {
    console.error(`Error Binance P2P ${fiat}/${tradeType}:`, error.message);
    return null;
  }
}

function tasaFinal(valor) {
  return Number.isFinite(valor) && valor > 0 ? Number(valor.toFixed(2)) : null;
}
function estadoRemitly() {
  const edadMs = verifiedRemitlyAt ? Date.now() - Date.parse(verifiedRemitlyAt) : Infinity;
  const vigente = Number.isFinite(verifiedRemitlyRate) && verifiedRemitlyRate > 0 &&
    Number.isFinite(edadMs) && edadMs >= 0 && edadMs <= REMITLY_RATE_TTL_MS;
  return {
    tasaUSD_COP: vigente ? tasaFinal(verifiedRemitlyRate) : null,
    verificada: vigente,
    actualizado: verifiedRemitlyAt,
    edadSegundos: Number.isFinite(edadMs) && edadMs >= 0 ? Math.floor(edadMs / 1000) : null,
    vigenciaSegundos: Math.floor(REMITLY_RATE_TTL_MS / 1000),
    mensaje: vigente ? 'Cotización verificada' : 'Cotización no disponible temporalmente.'
  };
}

app.get('/api/tasas', async (_req, res) => {
  const [vesBuy, vesSell, copBuy, copSell] = await Promise.all([
    obtenerTasaBinance('VES', 'BUY'), obtenerTasaBinance('VES', 'SELL'),
    obtenerTasaBinance('COP', 'BUY'), obtenerTasaBinance('COP', 'SELL')
  ]);
  const tasas = {
    VES_USDT_BUY: tasaFinal(vesBuy), VES_USDT_SELL: tasaFinal(vesSell),
    COP_USDT_BUY: tasaFinal(copBuy), COP_USDT_SELL: tasaFinal(copSell)
  };
  const enVivo = {
    VES_USDT_BUY: Number.isFinite(vesBuy) && vesBuy > 0,
    VES_USDT_SELL: Number.isFinite(vesSell) && vesSell > 0,
    COP_USDT_BUY: Number.isFinite(copBuy) && copBuy > 0,
    COP_USDT_SELL: Number.isFinite(copSell) && copSell > 0
  };
  const todoEnVivo = Object.values(enVivo).every(Boolean);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const remitly = estadoRemitly();
  if (!todoEnVivo) {
    return res.status(503).json({ success: false, tasas, enVivo, remitly,
      actualizado: new Date().toISOString(),
      error: 'No se pudieron obtener todas las cotizaciones P2P de Binance. No se devuelve una tasa antigua de respaldo.' });
  }
  res.json({ success: true, tasas, enVivo, remitly, actualizado: new Date().toISOString() });
});

// Secure endpoint to enter the rate verified in the actual Remitly quote screen.
// Set ADMIN_RATE_TOKEN in Render before using this endpoint. Rate expires automatically.
app.post('/api/remitly-rate', (req, res) => {
  if (!ADMIN_RATE_TOKEN || req.get('x-admin-token') !== ADMIN_RATE_TOKEN) {
    return res.status(401).json({ success: false, error: 'No autorizado.' });
  }
  const rate = Number(req.body?.rate);
  if (!Number.isFinite(rate) || rate < 1000 || rate > 10000) {
    return res.status(400).json({ success: false, error: 'La tasa debe ser un número COP/USD válido.' });
  }
  verifiedRemitlyRate = rate;
  verifiedRemitlyAt = new Date().toISOString();
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, remitly: estadoRemitly() });
});

app.get('/health', (_req, res) => res.json({ ok: true, servicio: 'Remex L.A. - Tasas P2P' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de tasas activo en puerto ${PORT}`));
