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

// ROTA 1: Criação de Assinatura Pix
app.post('/api/checkout', async (req, res) => {
  const { userId, planType = 'mensal' } = req.body; 

  console.log(`[Checkout] Criando assinatura [${planType.toUpperCase()}] para o UID: ${userId}`);

  // Definição de valores com base no plano escolhido
  let valueInCents = 1990; // R$ 19,90 padrão mensal
  let interval = 'MONTHLY';

  if (planType.toLowerCase() === 'anual') {
    valueInCents = 19900; // R$ 199,00 anual
    interval = 'YEARLY';
  }

  try {
    if (!process.env.OPENPIX_APP_ID) {
      return res.status(500).json(["Chave da Woovi não configurada no servidor."]);
    }

    const cleanAppID = process.env.OPENPIX_APP_ID.replace(/['"\n\r\s]/g, '');
    const correlationID = `sub_${userId}_${Date.now()}`;

    // Chamada baseada na documentação de Subscription da Woovi
    const wooviResponse = await axios.post('https://api.woovi-sandbox.com/api/v1/subscriptions', {
      reference: correlationID,
      value: valueInCents,
      interval: interval,
      name: `Assinatura MedWise - Plano ${planType.toUpperCase()}`,
      // Nota: Dependendo da regra do Sandbox, pode ser necessário passar um objeto customer mockado.
      customer: {
        name: "Médico Teste Silva",
        taxID: "00000000000" 
      }
    }, {
      headers: {
        'Accept': 'application/json',
        'Authorization': cleanAppID, 
        'Content-Type': 'application/json'
      }
    });

    // A Woovi retorna a subscription criada e a primeira cobrança (charge) dentro dela
    const subscriptionData = wooviResponse.data.subscription;
    const chargeData = wooviResponse.data.charge; // Primeira fatura gerada

    console.log(`[Woovi] Assinatura iniciada! ID: ${subscriptionData.globalID}`);

    if (admin.apps.length > 0) {
      const db = admin.firestore();
      
      // 1. Atualiza o status atual do usuário para aguardando pagamento
      await db.collection('user').doc(userId).set({
        ultimoPagamentoID: chargeData.correlationID, // Monitoramos a cobrança atual no Webhook
        subscriptionID: subscriptionData.globalID,
        tipoPlano: planType.toUpperCase(),
        statusPagamento: "PENDENTE"
      }, { merge: true });

      // 2. Cria um registro na coleção histórica de assinaturas
      await db.collection('assinaturas').doc(subscriptionData.globalID).set({
        userId: userId,
        status: "PENDING",
        intervalo: interval,
        valor: valueInCents / 100,
        createdAt: new Date()
      });
    }

    // Retorna os dados limpos em formato de array exigido pelo seu ecossistema
    return res.json([{
      success: true,
      correlationID: chargeData.correlationID,
      pixCopiaCola: chargeData.brCode,
      qrcodeImagem: chargeData.qrCodeImage,
      linkPagamento: chargeData.paymentLinkUrl
    }]);

  } catch (error) {
    console.error('[Erro na Assinatura]:', error.response ? error.response.data : error.message);
    return res.status(500).json(["Erro interno ao processar assinatura"]);
  }
});

// ROTA 2: Webhook da Woovi (Mantido para escutar os pagamentos das faturas das assinaturas)
app.post('/api/webhook', async (req, res) => {
  try {
    const evento = req.body.event;
    const charge = req.body.charge || req.body.data?.charge;

    // Quando o cliente paga a primeira ou qualquer fatura subsequente da assinatura
    if (evento && evento.includes('CHARGE_COMPLETED') && charge && charge.correlationID) {
      const correlationID = charge.correlationID;
      console.log(`[Webhook] Mensalidade/Anuidade Paga! Processando ID: ${correlationID}`);

      if (admin.apps.length > 0) {
        const db = admin.firestore();
        const usersRef = db.collection('user');
        const snapshot = await usersRef.where('ultimoPagamentoID', '==', correlationID).get();

        if (!snapshot.empty) {
          const batch = db.batch();
          snapshot.forEach(doc => {
            const userData = doc.data();
            
            // Atualiza o usuário para Premium ativo
            batch.update(doc.ref, { 
              statusPagamento: "PAGO",
              planoPremium: true 
            });

            // Atualiza a tabela de assinaturas vinculada
            if (userData.subscriptionID) {
              const subRef = db.collection('assinaturas').doc(userData.subscriptionID);
              batch.update(subRef, { status: "ACTIVE", updatedAt: new Date() });
            }
          });
          await batch.commit();
          console.log(`[Firestore] Assinatura Ativada/Renovada com sucesso!`);
        }
      }
    }

    return res.status(200).json(["Webhook de assinatura processado"]);
  } catch (error) {
    console.error('[Erro no Webhook]:', error);
    return res.status(500).json(["Erro interno ao processar webhook"]);
  }
});

app.get('/', (req, res) => {
  res.send('🚀 Servidor MedWise ativo com suporte a Assinaturas Recorrentes!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});