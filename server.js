const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.disable('x-powered-by');

const BINANCE_QUOTE_URL = 'https://www.binance.com/bapi/c2c/v1/public/c2c/agent/quote-price';

// Solo se usan si Binance no responde. No se presentan como tasas en vivo.

function extraerPrecio(data) {
  const candidatos = [
    data?.data?.price,
    data?.data?.quotePrice,
    data?.data?.bestPrice,
    data?.price,
    data?.quotePrice,
    data?.bestPrice
  ];
  for (const valor of candidatos) {
    const numero = Number(valor);
    if (Number.isFinite(numero) && numero > 0) return numero;
  }
  return null;
}

async function obtenerTasaBinance(fiat, tradeType) {
  try {
    const response = await axios.get(BINANCE_QUOTE_URL, {
      params: { fiat, asset: 'USDT', tradeType },
      timeout: 10000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Remex-LA-P2P/1.0'
      }
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

app.get('/api/tasas', async (_req, res) => {
  const [vesBuy, vesSell, copBuy, copSell] = await Promise.all([
    obtenerTasaBinance('VES', 'BUY'),
    obtenerTasaBinance('VES', 'SELL'),
    obtenerTasaBinance('COP', 'BUY'),
    obtenerTasaBinance('COP', 'SELL')
  ]);

  const tasas = {
    VES_USDT_BUY: tasaFinal(vesBuy),
    VES_USDT_SELL: tasaFinal(vesSell),
    COP_USDT_BUY: tasaFinal(copBuy),
    COP_USDT_SELL: tasaFinal(copSell)
  };

  const enVivo = {
    VES_USDT_BUY: Number.isFinite(vesBuy) && vesBuy > 0,
    VES_USDT_SELL: Number.isFinite(vesSell) && vesSell > 0,
    COP_USDT_BUY: Number.isFinite(copBuy) && copBuy > 0,
    COP_USDT_SELL: Number.isFinite(copSell) && copSell > 0
  };

  const todoEnVivo = Object.values(enVivo).every(Boolean);
  if (!todoEnVivo) {
    return res.status(503).json({
      success: false,
      tasas,
      enVivo,
      actualizado: new Date().toISOString(),
      error: 'No se pudieron obtener todas las cotizaciones P2P de Binance. No se devuelve una tasa antigua de respaldo.'
    });
  }

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({
    success: true,
    tasas,
    enVivo,
    actualizado: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, servicio: 'Remex L.A. - Tasas P2P' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de tasas activo en http://localhost:${PORT}`));
