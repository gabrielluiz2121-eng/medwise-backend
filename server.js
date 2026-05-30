const express = require('express');
const cors = require('cors');

const app = express();

// Libera o acesso para o FlutterFlow Web
app.use(cors({ origin: true }));
app.use(express.json());

// Rota de Teste (Simula a geração do Pix)
app.post('/api/checkout', (req, res) => {
  const { userId } = req.body;

  console.log(`[Sucesso] O FlutterFlow chamou o servidor! ID recebido: ${userId}`);

  // Responde imediatamente com dados falsos para preencher a tela do app
  return res.json({
    success: true,
    correlationID: `teste_${userId}`,
    pixCopiaCola: "00020101021226870014br.gov.bcb.pix...TESTE_OK",
    qrcodeImagem: "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=ConexaoPerfeita",
    linkPagamento: "https://railway.app"
  });
});

// Rota inicial para vermos no navegador
app.get('/', (req, res) => {
  res.send('🚀 O Servidor MedWise está online e respondendo na nuvem!');
});

// Inicialização (O Railway injeta a própria porta através do process.env.PORT)
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor base ativo na porta ${PORT}`);
});