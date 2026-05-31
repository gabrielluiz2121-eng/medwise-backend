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

// ROTA: Geração de Pix e Registo no Banco de Dados
app.post('/api/checkout', async (req, res) => {
  const { userId, valueInCents = 2990 } = req.body; 

  console.log(`[Checkout] A iniciar geração de Pix para o UID: ${userId}`);

  try {
    if (!process.env.OPENPIX_APP_ID) {
      return res.status(500).json({ error: "Chave da Woovi não configurada no servidor." });
    }

    // Limpeza defensiva: remove aspas, espaços e quebras de linha que o Railway possa ter injetado
    const cleanAppID = process.env.OPENPIX_APP_ID.replace(/['"\n\r\s]/g, '');
    console.log(`[Segurança] Chave sanitizada. Final da chave enviada: ...${cleanAppID.slice(-5)}`);

    const correlationID = `premium_${userId}_${Date.now()}`;

    // POST ajustado com cabeçalho Accept e URL openpix
    const wooviResponse = await axios.post('https://api.woovi-sandbox.com/api/v1/charge', {
      correlationID: correlationID,
      value: valueInCents,
      comment: "Assinatura Premium MedWise"
    }, {
      headers: {
        'Accept': 'application/json',
        'Authorization': cleanAppID, 
        'Content-Type': 'application/json'
      }
    });

    const chargeData = wooviResponse.data.charge;
    console.log(`[Woovi] Pix gerado com sucesso! CorrelationID: ${correlationID}`);

    if (admin.apps.length > 0) {
      const db = admin.firestore();
      await db.collection('user').doc(userId).set({
        ultimoPagamentoID: correlationID,
        statusPagamento: "PENDENTE"
      }, { merge: true });
      console.log(`[Firestore] Intenção de compra registada para o utilizador ${userId}.`);
    }

    return res.json({
      success: true,
      correlationID: correlationID,
      pixCopiaCola: chargeData.brCode,
      qrcodeImagem: chargeData.qrCodeImage,
      linkPagamento: chargeData.paymentLinkUrl
    });

  } catch (error) {
    console.error('[Erro na Integração]:', error.response ? error.response.data : error.message);
    return res.status(500).json({ error: "Erro interno ao processar pagamento" });
  }
});

app.get('/', (req, res) => {
  res.send('🚀 Servidor MedWise ativo e a comunicar com a Woovi!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});