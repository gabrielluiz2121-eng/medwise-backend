const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

// Inicialização do Stripe com a chave secreta
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 

const app = express();

// Webhook do Stripe (DEVE ficar antes do express.json para não quebrar a assinatura digital)
app.post('/api/webhook-stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const planType = session.metadata.planType;

    console.log(`[Stripe Webhook] Assinatura paga com sucesso para o usuário: ${userId}`);

    if (admin.apps.length > 0) {
      const db = admin.firestore();
      
      await db.collection('user').doc(userId).set({
        statusPagamento: "PAGO",
        planoPremium: true,
        tipoPlano: planType,
        stripeSubscriptionID: session.subscription
      }, { merge: true });
    }
  }

  res.json({ received: true });
});

// Middlewares globais (A partir daqui o servidor entende JSON)
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

// ROTA: Criação de Assinatura Pix (Woovi)
app.post('/api/checkout', async (req, res) => {
  const { userId, planType = 'mensal' } = req.body; 

  console.log(`[Checkout Woovi] Criando assinatura [${planType.toUpperCase()}] para o UID: ${userId}`);

  let valueInCents = 1990;
  let interval = 'MONTHLY';

  if (planType.toLowerCase() === 'anual') {
    valueInCents = 19900;
    interval = 'YEARLY';
  }

  try {
    if (!process.env.OPENPIX_APP_ID) {
      return res.status(500).json(["Chave da Woovi não configurada no servidor."]);
    }

    const cleanAppID = process.env.OPENPIX_APP_ID.replace(/['"\n\r\s]/g, '');
    const correlationID = `sub_${userId}_${Date.now()}`;

    const wooviResponse = await axios.post('https://api.woovi-sandbox.com/api/v1/subscriptions', {
      reference: correlationID,
      value: valueInCents,
      interval: interval,
      name: `Assinatura MedWise - Plano ${planType.toUpperCase()}`,
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

    const subscriptionData = wooviResponse.data.subscription;
    const chargeData = wooviResponse.data.charge;

    console.log(`[Woovi] Assinatura iniciada! ID: ${subscriptionData.globalID}`);

    if (admin.apps.length > 0) {
      const db = admin.firestore();
      
      await db.collection('user').doc(userId).set({
        ultimoPagamentoID: chargeData.correlationID,
        subscriptionID: subscriptionData.globalID,
        tipoPlano: planType.toUpperCase(),
        statusPagamento: "PENDENTE"
      }, { merge: true });

      await db.collection('assinaturas').doc(subscriptionData.globalID).set({
        userId: userId,
        status: "PENDING",
        intervalo: interval,
        valor: valueInCents / 100,
        createdAt: new Date()
      });
    }

    return res.json([{
      success: true,
      correlationID: chargeData.correlationID,
      pixCopiaCola: chargeData.brCode,
      qrcodeImagem: chargeData.qrCodeImage,
      linkPagamento: chargeData.paymentLinkUrl
    }]);

  } catch (error) {
    console.error('[Erro na Assinatura Woovi]:', error.response ? error.response.data : error.message);
    return res.status(500).json(["Erro interno ao processar assinatura Woovi"]);
  }
});

// ROTA NOVA: Criação de Assinatura Cartão (Stripe Embedded)
app.post('/api/checkout-stripe-embedded', async (req, res) => {
  const { userId, planType = 'mensal' } = req.body;

  console.log(`[Stripe Embedded] Criando intenção [${planType.toUpperCase()}] para o UID: ${userId}`);

  let priceId = process.env.STRIPE_PRICE_MENSAL;
  if (planType.toLowerCase() === 'anual') {
    priceId = process.env.STRIPE_PRICE_ANUAL;
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY || !priceId) {
      return res.status(500).json(["Configurações do Stripe ausentes."]);
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      return_url: `https://checkout.medwise.app.br/retorno?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        userId: userId,
        planType: planType.toUpperCase()
      },
    });

    console.log(`[Stripe Embedded] Sessão criada! Secret: ${session.client_secret.substring(0, 10)}...`);

    // Retorno em lista para manter a consistência de formatação solicitada
    return res.json([{
      success: true,
      client_secret: session.client_secret
    }]);

  } catch (error) {
    console.error('[Erro no Stripe Embedded]:', error.message);
    return res.status(500).json(["Erro ao criar sessão embedded no Stripe"]);
  }
});

// Webhook da Woovi
app.post('/api/webhook', async (req, res) => {
  try {
    const evento = req.body.event;
    const charge = req.body.charge || req.body.data?.charge;

    if (evento && evento.includes('CHARGE_COMPLETED') && charge && charge.correlationID) {
      const correlationID = charge.correlationID;
      console.log(`[Webhook Woovi] Mensalidade/Anuidade Paga! Processando ID: ${correlationID}`);

      if (admin.apps.length > 0) {
        const db = admin.firestore();
        const usersRef = db.collection('user');
        const snapshot = await usersRef.where('ultimoPagamentoID', '==', correlationID).get();

        if (!snapshot.empty) {
          const batch = db.batch();
          snapshot.forEach(doc => {
            const userData = doc.data();
            
            batch.update(doc.ref, { 
              statusPagamento: "PAGO",
              planoPremium: true 
            });

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
    console.error('[Erro no Webhook Woovi]:', error);
    return res.status(500).json(["Erro interno ao processar webhook da Woovi"]);
  }
});

// Rota Base e Inicialização do Servidor
app.get('/', (req, res) => {
  res.send('🚀 Servidor MedWise ativo com suporte a Assinaturas (Woovi Pix + Stripe Embedded)!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});