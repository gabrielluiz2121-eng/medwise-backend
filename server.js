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

// ROTA 1: Geração de Pix e Registo no Banco de Dados
app.post('/api/checkout', async (req, res) => {
  const { userId, valueInCents = 2990 } = req.body; 

  console.log(`[Checkout] A iniciar geração de Pix para o UID: ${userId}`);

  try {
    if (!process.env.OPENPIX_APP_ID) {
      return res.status(500).json(["Chave da Woovi não configurada no servidor."]);
    }

    const cleanAppID = process.env.OPENPIX_APP_ID.replace(/['"\n\r\s]/g, '');
    const correlationID = `premium_${userId}_${Date.now()}`;

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
        statusPagamento: "PENDENTE",
        planoPremium: false
      }, { merge: true });
    }

    return res.json([JSON.stringify({
      success: true,
      correlationID: correlationID,
      pixCopiaCola: chargeData.brCode,
      qrcodeImagem: chargeData.qrCodeImage,
      linkPagamento: chargeData.paymentLinkUrl
    })]);

  } catch (error) {
    console.error('[Erro na Integração]:', error.response ? error.response.data : error.message);
    return res.status(500).json(["Erro interno ao processar pagamento"]);
  }
});

// ROTA 2: Webhook da Woovi (Recebe a confirmação de pagamento)
app.post('/api/webhook', async (req, res) => {
  try {
    const evento = req.body.event;
    const charge = req.body.charge || req.body.data?.charge;

    // Só executa a lógica e gera logs se for de fato uma confirmação de pagamento de Pix concluído
    if (evento && evento.includes('CHARGE_COMPLETED') && charge && charge.correlationID) {
      const correlationID = charge.correlationID;
      console.log(`[Webhook] Pix Pago Confirmado! Processando ID: ${correlationID}`);

      if (admin.apps.length > 0) {
        const db = admin.firestore();
        const usersRef = db.collection('user');
        const snapshot = await usersRef.where('ultimoPagamentoID', '==', correlationID).get();

        if (!snapshot.empty) {
          const batch = db.batch();
          snapshot.forEach(doc => {
            batch.update(doc.ref, { 
              statusPagamento: "PAGO",
              planoPremium: true 
            });
          });
          await batch.commit();
          console.log(`[Firestore] Plano Premium ativado com sucesso para o ID: ${correlationID}`);
        } else {
          console.log(`[Firestore] Alerta: Nenhum utilizador correspondente ao ID: ${correlationID}`);
        }
      }
    }

    // Retorna o sucesso de forma limpa
    return res.status(200).json(["Webhook processado com sucesso"]);

  } catch (error) {
    console.error('[Erro no Webhook]:', error);
    return res.status(500).json(["Erro interno ao processar webhook"]);
  }
});

app.get('/', (req, res) => {
  res.send('🚀 Servidor ativo: Gerando Pix e escutando Webhooks!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});