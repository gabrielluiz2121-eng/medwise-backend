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
// 2. HEALTH CHECK (TESTE NO NAVEGADOR)
// ==========================================
app.get('/', (req, res) => {
  res.status(200).send('🚀 Servidor da API do MedWise está online e operacional!');
});

// ==========================================
// 3. WEBHOOK DO STRIPE (Requer express.raw)
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

    if (!db) return res.status(500).json([{ error: "erro_banco_dados" }]);

    try {
      const updateUser = db.collection('user').doc(userId).set({
        planoAtivo: planType,
        statusAssinatura: 'ativa',
        gateway: 'stripe',
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
  res.status(200).json([{ received: true }]);
});

// ==========================================
// 4. MIDDLEWARES PARA AS DEMAIS ROTAS
// ==========================================
app.use(express.json());

// ==========================================
// 5. ROTAS DE CRIAÇÃO (CHECKOUT)
// ==========================================

// 5.1 STRIPE EMBEDDED
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
    
    return res.json([{
      client_secret: session.client_secret
    }]);

  } catch (error) {
    return res.status(500).json([{ error: "erro_criacao_sessao" }]);
  }
});

// 5.2 WOOVI (PIX AUTOMÁTICO - CLONE DO MODELO DE SUCESSO)
app.post('/api/checkout-woovi', async (req, res) => {
  const { userId, planType = 'mensal', userCpf, userName } = req.body;
  const value = planType.toLowerCase() === 'anual' ? 49900 : 4990; 
  const frequencia = planType.toLowerCase() === 'anual' ? 'YEARLY' : 'MONTHLY';

  try {
    const cpfLimpo = userCpf.replace(/\D/g, '');

    // Calcula a data segura (mínimo de 3 dias no futuro para o ONLY_RECURRENCY)
    const dataFutura = new Date();
    dataFutura.setDate(dataFutura.getDate() + 4);
    
    let diaSeguro = dataFutura.getDate();
    if (diaSeguro > 28) diaSeguro = 28;

    const payloadClone = {
      name: "Assinatura MedWise", // Campo que existia no seu teste
      value: value,
      customer: { 
        name: userName, 
        taxID: cpfLimpo,
        email: "contato@medwise.app.br", // Do teste
        phone: "5511999999999",          // Do teste
        address: {                       // Endereço exato do seu teste
          zipcode: "04556300",
          street: "rua de são paulo",
          number: "3432",
          neighborhood: "BROOKLIN PAULISTA",
          city: "SAO PAULO",
          state: "SP",
          complement: "CONJ 26" // O complemento estava no seu teste e não no nosso
        }
      },
      correlationID: `sub_${userId}_${Date.now()}`, // Identificador único (evita bloqueio antifraude)
      comment: "Assinatura do aplicativo", // Campo que existia no seu teste
      frequency: frequencia,
      type: "PIX_RECURRING",
      pixRecurringOptions: { 
        journey: "ONLY_RECURRENCY", 
        retryPolicy: "NON_PERMITED" 
      },
      dayGenerateCharge: diaSeguro, 
      dayDue: 3, // Exatamente igual ao seu teste
      metadata: { 
        userId: userId, 
        planType: planType.toUpperCase() 
      }
    };

    const response = await fetch('https://api.woovi.com/api/v1/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': process.env.WOOVI_APP_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payloadClone)
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('[Woovi API Error]:', JSON.stringify(data));
      throw new Error(data.error || "Falha ao comunicar com a Woovi");
    }

return res.json([ data.subscription.paymentLinkUrl ]);

  } catch (error) {
    console.error('[Erro Woovi Checkout]:', error.message);
    return res.status(500).json([{ error: "erro_criacao_woovi" }]);
  }
});

// ==========================================
// 6. WEBHOOK DA WOOVI
// ==========================================
app.post('/api/webhook/woovi', async (req, res) => {
  const evento = req.body.event;
  const charge = req.body.charge;

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
        userId: userId, 
        plano: planType, 
        status: 'ativa', 
        gateway: 'woovi', 
        wooviSubscriptionId: subId,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const createPagamento = db.collection('pagamentos').doc(charge.correlationID).set({
        userId: userId, 
        plano: planType, 
        valor: charge.value / 100, 
        moeda: 'BRL', 
        statusPagamento: 'paid', 
        gateway: 'woovi',
        dataPagamento: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await Promise.all([updateUser, createAssinatura, createPagamento]);
    } catch (error) {
      console.error(`[Erro Firebase Woovi]:`, error.message);
    }
  }
  res.status(200).json([{ received: true }]);
});

// ==========================================
// 7. ORQUESTRADOR: GERENCIAMENTO E CANCELAMENTO
// ==========================================

// 7.1 Rota Unificada de Portal
app.post('/api/gerenciar-assinatura', async (req, res) => {
  const { userId } = req.body;

  try {
    const userDoc = await db.collection('user').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json([{ error: "erro_usuario_nao_encontrado" }]);
    
    const userData = userDoc.data();

    if (userData.gateway === 'stripe') {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: userData.stripeCustomerId,
        return_url: 'medwise://home', 
      });
      return res.json([{ url: portalSession.url }]);
    } 
    
    if (userData.gateway === 'woovi') {
      return res.json([{ status: "gateway_woovi" }]); 
    }

    return res.status(400).json([{ error: "erro_sem_assinatura" }]);
  } catch (error) {
    return res.status(500).json([{ error: "erro_gerar_portal" }]);
  }
});

// 7.2 Rota Unificada de Cancelamento
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

    await db.collection('user').doc(userId).update({
      statusAssinatura: 'cancelada',
      planoAtivo: 'gratuito'
    });

    return res.json([{ status: "cancelamento_efetuado" }]);

  } catch (error) {
    console.error('[Erro Cancelamento]:', error.message);
    return res.status(500).json([{ error: "erro_ao_cancelar" }]);
  }
});

// ==========================================
// 8. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});