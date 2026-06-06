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
    
    // A variável db é declarada no topo (let) e populada aqui
    db = admin.firestore();
    console.log("Firebase Admin inicializado com sucesso!");
  }
} catch (error) {
  console.error("🚨 ERRO CRÍTICO no Firebase Admin:", error.message);
  // Se houver erro, a variável db fica vazia, mas o servidor continua rodando.
}

const app = express();

// Permite requisições do seu app/web
app.use(cors());

// ==========================================
// 2. WEBHOOK DO STRIPE (MUITO IMPORTANTE: DEVE VIR ANTES DO EXPRESS.JSON)
// ==========================================
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[Erro Webhook] Falha na assinatura: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const planType = session.metadata.planType; 

    if (!db) {
        console.error(`[Erro Crítico Webhook] Impossível salvar o UID ${userId}. O Firebase (db) não está conectado.`);
        return res.status(500).json({ error: "Banco de dados indisponível." });
    }

    try {
      // 1. Atualizar o Perfil do Usuário (mantido para o app ler rapidamente)
      const updateUser = db.collection('user').doc(userId).set({
        planoAtivo: planType,
        statusAssinatura: 'ativa',
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // 2. Registrar na coleção 'assinaturas' (Usamos o ID da assinatura da Stripe para evitar duplicatas)
      const createAssinatura = db.collection('assinaturas').doc(session.subscription).set({
        userId: userId,
        plano: planType,
        status: 'ativa',
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // 3. Registrar na coleção 'pagamentos' (Usamos o ID da sessão de checkout)
      const valorFormatado = session.amount_total / 100; // A Stripe envia valores em centavos (ex: 2990 = 29.90)
      
      const createPagamento = db.collection('pagamentos').doc(session.id).set({
        userId: userId,
        plano: planType,
        valor: valorFormatado,
        moeda: session.currency,
        statusPagamento: session.payment_status,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        dataPagamento: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Executa as três operações no banco de dados ao mesmo tempo
      await Promise.all([updateUser, createAssinatura, createPagamento]);

      console.log(`[Sucesso] Usuário ${userId} atualizado, assinatura e pagamento registrados.`);
    } catch (error) {
      console.error(`[Erro Firebase] Falha ao registrar dados para UID ${userId}:`, error.message);
    }
  }

  res.status(200).json({ received: true });
});

// ==========================================
// 3. MIDDLEWARES GERAIS
// ==========================================
app.use(express.json());

// ==========================================
// 4. ROTA DE CRIAÇÃO DO CHECKOUT
// ==========================================
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
      ui_mode: 'embedded_page',
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
return_url: `medwise://medwise2.com/Home`,
      metadata: {
        userId: userId,
        planType: planType.toUpperCase()
      },
    });

    console.log(`[Stripe Embedded] Sessão criada! Secret: ${session.client_secret.substring(0, 10)}...`);

    return res.json([{
      success: true,
      client_secret: session.client_secret
    }]);

  } catch (error) {
    console.error('[Erro no Stripe Embedded]:', error.message);
    return res.status(500).json(["Erro ao criar sessão embedded no Stripe"]);
  }
});

// ==========================================
// 5. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});