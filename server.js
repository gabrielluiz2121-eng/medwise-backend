const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// Libera o acesso para o FlutterFlow Web
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
    console.error('[Firebase] Erro ao ler a variável FIREBASE_CREDENTIALS:', error.message);
  }
} else {
  console.log('[Firebase] Aviso: FIREBASE_CREDENTIALS não encontrada. Rodando sem banco de dados.');
}

// Rota de Teste (Agora simulando a gravação no banco)
app.post('/api/checkout', async (req, res) => {
  const { userId } = req.body;

  console.log(`[Railway] FF chamou! Tentando atualizar o usuário: ${userId}`);

  try {
    // SE o Firebase estiver ativo, vamos tentar criar/atualizar um documento de teste no Firestore
    if (admin.apps.length > 0) {
      const db = admin.firestore();
      
      // Isso vai criar ou atualizar um documento na sua coleção 'users' com o ID enviado
      await db.collection('users').doc(userId).set({
        testeConexao: "OK",
        atualizadoEm: new Date()
      }, { merge: true }); // O merge garante que não vai apagar os dados que o usuário já tinha lá
      
      console.log(`[Firestore] Documento do usuário ${userId} atualizado com sucesso!`);
    }

    // Devolve a resposta de sucesso para o FlutterFlow
    return res.json({
      success: true,
      correlationID: `teste_firebase_${userId}`,
      pixCopiaCola: "00020101021226870014br.gov.bcb.pix...TESTE_FIREBASE_OK",
      qrcodeImagem: "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=FirebaseFuncionando",
      linkPagamento: "https://railway.app"
    });

  } catch (error) {
    console.error('[Erro Firestore]:', error.message);
    return res.status(500).json({ error: "Erro interno ao salvar no banco" });
  }
});

// Rota inicial do navegador
app.get('/', (req, res) => {
  res.send('🚀 Servidor MedWise online e integrado ao Firebase!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});