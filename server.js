const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// Inicializa o Firebase usando a variável de ambiente do Railway
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
} else {
  console.log('[Firebase] Erro: Variável FIREBASE_CREDENTIALS não encontrada.');
}

// Rota de Teste de Leitura de E-mail
app.post('/api/checkout', async (req, res) => {
  const { userId } = req.body;

  console.log(`[Railway] Buscando no Firestore o e-mail do UID: ${userId}`);

  try {
    if (admin.apps.length === 0) {
      return res.status(500).json({ error: "Firebase não está inicializado no servidor." });
    }

    const db = admin.firestore();
    // Busca o documento do usuário na coleção 'users'
    const userDoc = await db.collection('users').doc(userId).get();

    // Verifica se o usuário realmente existe no banco
    if (!userDoc.exists) {
      console.log(`[Firestore] Usuário com UID ${userId} não foi encontrado.`);
      return res.status(404).json({
        success: false,
        message: `Usuário com UID [${userId}] não existe na coleção 'users'.`
      });
    }

    // Pega os dados do documento
    const userData = userDoc.data();
    const userEmail = userData.email || "E-mail não cadastrado neste documento";

    console.log(`[Firestore] Sucesso! O e-mail encontrado foi: ${userEmail}`);

    // Retorna a resposta para o FlutterFlow incluindo o e-mail real do banco
    return res.json({
      success: true,
      uidEnviado: userId,
      emailEncontrado: userEmail,
      message: "Comunicação e leitura do Firebase 100% OK!"
    });

  } catch (error) {
    console.error('[Erro de Leitura Firestore]:', error.message);
    return res.status(500).json({ error: "Erro interno ao buscar dados no Firebase" });
  }
});

app.get('/', (req, res) => {
  res.send('🚀 Servidor MedWise ativo e aguardando testes de leitura do Firebase!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de leitura ativo na porta ${PORT}`);
});