const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Función para obtener tasa de Binance P2P
async function obtenerTasaBinance(fiat) {
  try {
    const response = await axios.post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      asset: "USDT",
      fiat: fiat,
      merchantCheck: false,
      page: 1,
      rows: 5,
      tradeType: "BUY"
    });

    const ofertas = response.data.data;
    if (!ofertas || ofertas.length === 0) return 0;

    const suma = ofertas.reduce((acc, curr) => acc + parseFloat(curr.adv.price), 0);
    return suma / ofertas.length;
  } catch (error) {
    console.error(`Error consultando Binance (${fiat}):`, error.message);
    return 0;
  }
}

// Endpoint para entregar las tasas
app.get('/api/tasas', async (req, res) => {
  const [vesUsdt, copUsdt] = await Promise.all([
    obtenerTasaBinance('VES'),
    obtenerTasaBinance('COP')
  ]);

  res.json({
    success: true,
    tasas: {
      VES_USDT: parseFloat(vesUsdt.toFixed(2)) || 882,
      COP_USDT: parseFloat(copUsdt.toFixed(2)) || 3140
    }
  });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor de tasas activo en http://localhost:${PORT}`));