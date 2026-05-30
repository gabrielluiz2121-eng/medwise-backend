const express = require('express');
const cors = require('cors');

const app = express();

// Libera o acesso para o FlutterFlow Web
app.use(cors({ origin: true }));
app.use(express.json());

//  ROTA DE TESTE (Sem Woovi, Sem Firebase)
app.post('/api/checkout', (req, res) => {
  const { userId } = req.body;

  console.log(`[Railway] FlutterFlow chamou com sucesso! ID do Usuário: ${userId}`);

  // Retorna dados falsos de teste para o FlutterFlow preencher a tela
  return res.json({
    success: true,
    correlationID: `teste_isolado_${userId}`,
    pixCopiaCola: "00020101021226870014br.gov.bcb.pix...MEDWISE_TESTE_OK",
    qrcodeImagem: "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=MedWiseFuncionando",
    linkPagamento: "https://railway.app"
  });
});

// Rota para testar direto no seu navegador
app.get('/', (req, res) => {
  res.send(' O Servidor MedWise está online e respondendo na nuvem!');
});

// Configuração de Porta para o Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de testes ativo na porta ${PORT}`);
});