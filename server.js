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
    console.log("✅ Firebase Admin inicializado com sucesso!");
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

  if (!db) return res.status(500).json([{ error: "erro_banco_dados" }]);

  // 3.1 SUCESSO: ASSINATURA CRIADA E PAGA
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const planType = session.metadata.planType; 

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
      console.log(`✅ [Stripe] Assinatura salva para UID ${userId}`);
    } catch (error) {
      console.error(`[Erro Firebase Stripe Checkout]:`, error.message);
    }
  } 
  // 3.2 ATUALIZAÇÃO: TROCA DE PLANO OU STATUS
  else if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const subscriptionId = subscription.id; 
    const userId = subscription.metadata ? subscription.metadata.userId : null;
    const statusStripe = subscription.status; // 'active', 'past_due', 'canceled', etc.

    // Tenta descobrir o nome do novo plano (Mensal ou Anual)
    let planType = "MENSAL";
    if (subscription.plan) {
      if (subscription.plan.nickname) {
        planType = subscription.plan.nickname.toUpperCase();
      } else if (subscription.plan.interval === 'year') {
        planType = "ANUAL";
      }
    }

    try {
      // 1. Atualiza a coleção 'assinaturas'
      const updateAssinatura = db.collection('assinaturas').doc(subscriptionId).update({
        plano: planType,
        status: statusStripe === 'active' ? 'ativa' : statusStripe,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      // 2. Atualiza a coleção 'user'
      let updateUser = Promise.resolve();
      if (userId) {
        updateUser = db.collection('user').doc(userId).update({
          planoAtivo: planType,
          statusAssinatura: statusStripe === 'active' ? 'ativa' : statusStripe,
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      await Promise.all([updateAssinatura, updateUser]);
      console.log(`🔄 [Stripe] Assinatura atualizada: ${subscriptionId} | Novo plano: ${planType}`);

    } catch (error) {
      console.error('[Erro Atualizacao Firestore Stripe]:', error.message);
    }
  }
  // 3.3 FALHA/CANCELAMENTO: ASSINATURA DELETADA
  else if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const subscriptionId = subscription.id; 

    try {
      // 1. Atualiza o status na coleção 'assinaturas' (onde o ID do doc é o subscription.id)
      await db.collection('assinaturas').doc(subscriptionId).update({
        status: 'cancelada',
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`❌ [Stripe] Assinatura cancelada na coleção 'assinaturas': ${subscriptionId}`);

      // 2. Atualiza a coleção 'user' usando o userId guardado no metadata
      const userId = subscription.metadata ? subscription.metadata.userId : null;
      if (userId) {
        await db.collection('user').doc(userId).update({
          statusAssinatura: 'cancelada',
          planoAtivo: 'gratuito',
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`❌ [Stripe] Usuário ${userId} rebaixado para o plano gratuito.`);
      }

    } catch (error) {
      console.error('[Erro Cancelamento Firestore Stripe]:', error.message);
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
      subscription_data: {
        metadata: {
          userId: userId  // Garante que o webhook saiba quem é no momento do cancelamento
        }
      },
    });
    
    return res.json([{
      client_secret: session.client_secret
    }]);

  } catch (error) {
    return res.status(500).json([{ error: "erro_criacao_sessao" }]);
  }
});

// 5.2 WOOVI (PIX AUTOMÁTICO - COBRANÇA IMEDIATA)
app.post('/api/checkout-woovi', async (req, res) => {
  const { userId, planType = 'mensal', userCpf, userName } = req.body;
  const value = planType.toLowerCase() === 'anual' ? 19990 : 1990; 
  const frequencia = planType.toLowerCase() === 'anual' ? 'YEARLY' : 'MONTHLY';

  try {
    const cpfLimpo = userCpf.replace(/\D/g, '');

    // Para pagamento imediato (PAYMENT_ON_APPROVAL), a primeira cobrança roda na hora.
    let diaAtual = new Date().getDate();
    if (diaAtual > 28) diaAtual = 28; // Trava de segurança para meses curtos

    const payloadImediato = {
      name: "Assinatura MedWise",
      value: value,
      customer: { 
        name: userName, 
        taxID: cpfLimpo,
        email: "contato@medwise.app.br",
        phone: "5511999999999",
        address: {
          zipcode: "04556300",
          street: "rua de são paulo",
          number: "3432",
          neighborhood: "BROOKLIN PAULISTA",
          city: "SAO PAULO",
          state: "SP",
          complement: "CONJ 26"
        }
      },
      correlationID: `sub_${userId}_${Date.now()}`,
      comment: "Assinatura",
      frequency: frequencia,
      type: "PIX_RECURRING",
      pixRecurringOptions: { 
        journey: "PAYMENT_ON_APPROVAL",
        retryPolicy: "NON_PERMITED" 
      },
      dayGenerateCharge: diaAtual,
      dayDue: 3,
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
      body: JSON.stringify(payloadImediato)
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('[Woovi API Error]:', JSON.stringify(data));
      throw new Error(data.error || "Falha ao comunicar com a Woovi");
    }

    return res.json([ data.subscription.pixRecurring.emv ]); 

  } catch (error) {
    console.error('[Erro Woovi Checkout]:', error.message);
    return res.status(500).json([{ error: "erro_criacao_woovi" }]);
  }
});

// ==========================================
// 6. WEBHOOK DA WOOVI (COM ATUALIZAÇÃO COMPLETA NO FIREBASE)
// ==========================================
app.post('/api/webhook/woovi', async (req, res) => {
  try {
    const webhookData = req.body;
    const evento = webhookData.event;
    const correlationID = webhookData.correlationID;

    if (correlationID && correlationID.startsWith('sub_')) {
      const partes = correlationID.split('_');
      const userId = partes[1]; 
      
      // Assume que o plano é MENSAL se não vier 
      const planType = "MENSAL"; 
      
      // A Woovi envia o valor em centavos (ex: 1990 para R$ 19,90)
      const valorWoovi = webhookData.value ? webhookData.value / 100 : 0;

      if (evento === 'PIX_AUTOMATIC_APPROVED' || evento === 'PIX_AUTOMATIC_COBR_COMPLETED') {
        console.log(`✅ [ACESSO LIBERADO] Usuário: ${userId} | Woovi`);
        
        // 1. Atualiza a coleção 'user' (IDÊNTICO AO STRIPE)
        const updateUser = db.collection('user').doc(userId).set({ 
          statusAssinatura: 'ativa',
          planoAtivo: planType,
          gateway: 'woovi',
          wooviSubscriptionId: correlationID, // Necessário para a rota de cancelamento!
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 2. Atualiza a coleção 'assinaturas'
        const createAssinatura = db.collection('assinaturas').doc(correlationID).set({
          criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          gateway: "woovi",
          plano: planType,
          status: "ativa",
          wooviCorrelationId: correlationID,
          userId: userId 
        }, { merge: true });

        // 3. Cria o registro na coleção 'pagamentos'
        // Usa o ID global da Woovi se existir, senão gera um ID único
        const pagamentoId = webhookData.globalID || `pay_woovi_${Date.now()}`;
        const createPagamento = db.collection('pagamentos').doc(pagamentoId).set({
          userId: userId,
          plano: planType,
          valor: valorWoovi,
          moeda: 'brl',
          statusPagamento: evento === 'PIX_AUTOMATIC_COBR_COMPLETED' ? 'paid' : 'approved',
          gateway: 'woovi',
          dataPagamento: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Executa as 3 ações no banco de dados simultaneamente
        await Promise.all([updateUser, createAssinatura, createPagamento]);

      } else if (evento === 'PIX_AUTOMATIC_REJECTED' || evento === 'PIX_AUTOMATIC_CANCELED' || evento === 'PIX_AUTOMATIC_COBR_REJECTED') {
        console.log(`❌ [ACESSO BLOQUEADO] Usuário: ${userId} | Woovi`);
        
        // Cancela na coleção 'assinaturas'
        const cancelAssinatura = db.collection('assinaturas').doc(correlationID).set({
          status: "cancelada_ou_falha",
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // Cancela na coleção 'user'
        const cancelUser = db.collection('user').doc(userId).update({ 
          statusAssinatura: 'cancelada',
          planoAtivo: 'gratuito',
          dataAtualizacao: admin.firestore.FieldValue.serverTimestamp()
        });

        await Promise.all([cancelAssinatura, cancelUser]);
      }
    } else {
      console.log(`⚠️ Webhook da Woovi recebido sem correlationID válido.`);
    }

    return res.status(200).send('Webhook processado');
  } catch (error) {
    console.error('[Erro no Webhook Woovi]:', error.message);
    return res.status(500).send('Erro interno');
  }
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