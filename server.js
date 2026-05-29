const express = require('express')

const { db } = require('./firebase/admin')

const app = express()

app.use(express.json())

// TESTE API
app.get('/', (req, res) => {
  res.send('MedWise API Online 🚀')
})

// TESTE FIRESTORE
app.get('/test-firestore', async (req, res) => {

  try {

    const snapshot = await db.collection('users').get()

    res.send(`Encontrados ${snapshot.size} usuários`)

  } catch (error) {

    console.error(error)

    res.status(500).send('Erro ao acessar Firestore')

  }

})

app.listen(3000, () => {
  console.log('Servidor rodando na porta 3000')
})