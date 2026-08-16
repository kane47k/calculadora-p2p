const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

async function obtenerTasaBinanceP2P(fiat, tradeType) {
  try {
    const response = await fetch('https://p2p.binance.com/bapi/c2c/v1/friendly/c2c/ad/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: 'USDT',
        fiat: fiat,
        merchantCheck: false,
        page: 1,
        rows: 5,
        tradeType: tradeType // "BUY" para cuando el cliente paga en Fiat, "SELL" para cuando recibe Fiat
      })
    });
    const data = await response.json();
    if (data && data.data && data.data.length > 0) {
      const precios = data.data.slice(0, 3).map(ad => parseFloat(ad.adv.price));
      return precios.reduce((a, b) => a + b, 0) / precios.length;
    }
  } catch (e) {
    console.error(`Error en Binance P2P para ${fiat} (${tradeType}):`, e);
  }
  return null;
}

app.get('/api/tasas', async (req, res) => {
  const vesUsdt = await obtenerTasaBinanceP2P('VES', 'BUY') || 882;
  const copUsdtBuy = await obtenerTasaBinanceP2P('COP', 'BUY') || 3135;   // Tasa de compra P2P
  const copUsdtSell = await obtenerTasaBinanceP2P('COP', 'SELL') || 3105; // Tasa de venta P2P

  res.json({
    success: true,
    tasas: {
      VES_USDT: vesUsdt,
      COP_USDT_BUY: copUsdtBuy,
      COP_USDT_SELL: copUsdtSell
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de tasas activo en puerto ${PORT}`));
