const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// Inicializa o Firebase
if (process.env.FIREBASE_CREDENTIALS) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('[Firebase] Conectado com sucesso ao Firestore!');
  } catch (error) {
    console.error('[Firebase] Erro ao inicializar:', error.message);
  }
}

// ROTA: Geração de Pix Real na Woovi
app.post('/api/checkout', async (req, res) => {
  // Recebe o ID do usuário e define 2990 (R$ 29,90) como valor padrão, caso não venha do FlutterFlow
  const { userId, valueInCents = 2990 } = req.body; 

  console.log(`[Checkout] Iniciando geração de Pix para o UID: ${userId}`);

  try {
    if (!process.env.OPENPIX_APP_ID) {
      return res.status(500).json({ error: "Chave da Woovi não configurada no servidor." });
    }

    // 1. Gera um ID único para essa transação (Correlation ID)
    // O Timestamp (Date.now) garante que o ID nunca se repita se o médico tentar gerar 2 vezes
    const correlationID = `premium_${userId}_${Date.now()}`;

    // 2. Envia o pedido de cobrança para a Woovi
    const wooviResponse = await axios.post('https://api.openpix.com.br/api/v1/charge', {
      correlationID: correlationID,
      value: valueInCents,
      comment: "Assinatura Premium"
    }, {
      headers: {
        'Authorization': process.env.OPENPIX_APP_ID,
        'Content-Type': 'application/json'
      }
    });

    const chargeData = wooviResponse.data.charge;
    console.log(`[Woovi] Pix gerado com sucesso! CorrelationID: ${correlationID}`);

    // 3. Retorna os dados oficiais para o FlutterFlow exibir na tela
    return res.json({
      success: true,
      correlationID: correlationID,
      pixCopiaCola: chargeData.brCode,
      qrcodeImagem: chargeData.qrCodeImage,
      linkPagamento: chargeData.paymentLinkUrl
    });

  } catch (error) {
    console.error('[Erro na Woovi]:', error.response ? error.response.data : error.message);
    return res.status(500).json({ error: "Erro interno ao processar pagamento" });
  }
});

app.get('/', (req, res) => {
  res.send('🚀 Servidor MedWise ativo e gerando Pix com a Woovi!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de produção ativo na porta ${PORT}`);
});