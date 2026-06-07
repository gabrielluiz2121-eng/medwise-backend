const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// ==========================================
// 1. INICIALIZAÇÃO DO FIREBASE ADMIN
// ==========================================
let db;
try {
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("A variável FIREBASE_SERVICE_ACCOUNT está vazia ou não existe no Railway.");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Admin inicializado com sucesso!");
  }
} catch (error) {
  console.error("🚨 ERRO CRÍTICO no Firebase Admin:", error.message);
}

const app = express();
app.use(cors());

// ==========================================
// 2. WEBHOOK DO STRIPE (Requer express.raw)
// ==========================================
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[Erro Webhook Stripe] Falha: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const planType = session.metadata.planType; 

    if (!db) return res.status(500).json(["erro_banco_dados"]);

    try {
      const updateUser = db.collection('user').doc(userId).set({
        planoAtivo: planType,
        statusAssinatura: 'ativa',
        gateway: 'stripe', // FLAG IMPORTANTE PARA O ORQUESTRADOR
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const createAssinatura = db.collection('assinaturas').doc(session.subscription).set({
        userId: userId,
        plano: planType,
        status: 'ativa',
        gateway: 'stripe',
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const createPagamento = db.collection('pagamentos').doc(session.id).set({
        userId: userId,
        plano: planType,
        valor: session.amount_total / 100,
        moeda: session.currency,
        statusPagamento: session.payment_status,
        gateway: 'stripe',
        dataPagamento: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await Promise.all([updateUser, createAssinatura, createPagamento]);
      console.log(`[Stripe] Assinatura salva para UID ${userId}`);
    } catch (error) {
      console.error(`[Erro Firebase Stripe]:`, error.message);
    }
  }
  res.status(200).json(["recebido"]);
});

// ==========================================
// 3. MIDDLEWARES PARA AS DEMAIS ROTAS
// ==========================================
app.use(express.json());

// ==========================================
// 4. ROTAS DE CRIAÇÃO (CHECKOUT)
// ==========================================

// 4.1 STRIPE EMBEDDED
app.post('/api/checkout-stripe-embedded', async (req, res) => {
  const { userId, planType = 'mensal' } = req.body;
  let priceId = planType.toLowerCase() === 'anual' ? process.env.STRIPE_PRICE_ANUAL : process.env.STRIPE_PRICE_MENSAL;

  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded_page',
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `medwise://medwise2.com/Home`,
      metadata: { userId, planType: planType.toUpperCase() },
    });
    return res.json([session.client_secret]);
  } catch (error) {
    return res.status(500).json(["erro_criacao_sessao"]);
  }
});

// 4.2 WOOVI (PIX AUTOMÁTICO)
app.post('/api/checkout-woovi', async (req, res) => {
  const { userId, planType = 'mensal', userCpf, userName } = req.body;
  // A API da Woovi exige valor em centavos e dados do cliente para Pix Automático
  const value = planType.toLowerCase() === 'anual' ? 49900 : 4990; 

  try {
    const response = await fetch('https://api.woovi.com/api/v1/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': process.env.WOOVI_APP_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        value: value,
        customer: { name: userName, taxID: userCpf },
        metadata: { userId, planType: planType.toUpperCase() }
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    // Retorna o link de pagamento/aprovação do Pix Automático
    return res.json([data.subscription.paymentLink]); 
  } catch (error) {
    console.error('[Erro Woovi Checkout]:', error.message);
    return res.status(500).json(["erro_criacao_woovi"]);
  }
});

// ==========================================
// 5. WEBHOOK DA WOOVI
// ==========================================
app.post('/api/webhook/woovi', async (req, res) => {
  const evento = req.body.event;
  const charge = req.body.charge;

  // Quando o Pix da assinatura é pago com sucesso
  if (evento === 'OPENPIX:CHARGE_COMPLETED' && charge.subscription) {
    const userId = charge.metadata.userId;
    const planType = charge.metadata.planType;
    const subId = charge.subscription;

    try {
      const updateUser = db.collection('user').doc(userId).set({
        planoAtivo: planType,
        statusAssinatura: 'ativa',
        gateway: 'woovi',
        wooviSubscriptionId: subId,
        dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const createAssinatura = db.collection('assinaturas').doc(subId).set({
        userId, plano: planType, status: 'ativa', gateway: 'woovi', wooviSubscriptionId: subId,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const createPagamento = db.collection('pagamentos').doc(charge.correlationID).set({
        userId, plano: planType, valor: charge.value / 100, moeda: 'BRL', statusPagamento: 'paid', gateway: 'woovi',
        dataPagamento: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await Promise.all([updateUser, createAssinatura, createPagamento]);
    } catch (error) {
      console.error(`[Erro Firebase Woovi]:`, error.message);
    }
  }
  res.status(200).json(["recebido"]);
});

// ==========================================
// 6. ORQUESTRADOR: GERENCIAMENTO E CANCELAMENTO
// ==========================================

// 6.1 Rota Unificada de Portal
app.post('/api/gerenciar-assinatura', async (req, res) => {
  const { userId } = req.body;

  try {
    const userDoc = await db.collection('user').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json(["erro_usuario_nao_encontrado"]);
    
    const userData = userDoc.data();

    if (userData.gateway === 'stripe') {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: userData.stripeCustomerId,
        return_url: 'medwise://home', 
      });
      return res.json([portalSession.url]);
    } 
    
    if (userData.gateway === 'woovi') {
      // Woovi não tem um "portal web". O app vai ler essa string e exibir apenas o botão de cancelar tela
      return res.json(["gateway_woovi"]); 
    }

    return res.status(400).json(["erro_sem_assinatura"]);
  } catch (error) {
    return res.status(500).json(["erro_gerar_portal"]);
  }
});

// 6.2 Rota Unificada de Cancelamento
app.post('/api/cancelar-assinatura', async (req, res) => {
  const { userId } = req.body;

  try {
    const userDoc = await db.collection('user').doc(userId).get();
    const userData = userDoc.data();

    if (userData.gateway === 'stripe' && userData.stripeSubscriptionId) {
      await stripe.subscriptions.cancel(userData.stripeSubscriptionId);
    } 
    else if (userData.gateway === 'woovi' && userData.wooviSubscriptionId) {
      const response = await fetch(`https://api.woovi.com/api/v1/subscriptions/${userData.wooviSubscriptionId}/cancel`, {
        method: 'PUT',
        headers: { 'Authorization': process.env.WOOVI_APP_ID }
      });
      if (!response.ok) throw new Error("Falha na Woovi");
    }

    // Atualiza o Firebase para rebaixar o usuário
    await db.collection('user').doc(userId).update({
      statusAssinatura: 'cancelada',
      planoAtivo: 'gratuito'
    });

    return res.json(["cancelamento_efetuado"]);

  } catch (error) {
    console.error('[Erro Cancelamento]:', error.message);
    return res.status(500).json(["erro_ao_cancelar"]);
  }
});

// ==========================================
// 7. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});