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

// ROTA: Teste de Escrita com Coleção Corrigida
app.post('/api/checkout', async (req, res) => {
  const { userId } = req.body;

  console.log(`[Railway] FF chamou! Tentando atualizar o documento na coleção 'user': ${userId}`);

  try {
    if (admin.apps.length === 0) {
      return res.status(500).json({ error: "Firebase não está inicializado no servidor." });
    }

    const db = admin.firestore();
    
    // Alvo ajustado para 'user' (singular) correspondendo exatamente ao seu banco de dados
    const userRef = db.collection('user').doc(userId);

    // Executa a escrita adicionando os campos de teste sem apagar o resto do documento
    await userRef.set({
      testeConexao: "OK",
      ultimoTesteEm: new Date()
    }, { merge: true });

    console.log(`[Firestore] Documento ${userId} atualizado com sucesso com as informações de teste!`);

    // Busca o e-mail atualizado para confirmar que a operação foi completa
    const updatedDoc = await userRef.get();
    const userData = updatedDoc.data();

    return res.json({
      success: true,
      uidProcessado: userId,
      emailConfirmado: userData.email || "E-mail não encontrado",
      testeConexao: userData.testeConexao,
      message: "Gravação e leitura na coleção 'user' validadas com sucesso!"
    });

  } catch (error) {
    console.error('[Erro de Escrita Firestore]:', error.message);
    return res.status(500).json({ error: "Erro interno ao atualizar dados no Firebase" });
  }
});

app.get('/', (req, res) => {
  res.send('🚀 Servidor MedWise pronto para o teste definitivo de escrita no Firebase!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de testes ativo na porta ${PORT}`);
});