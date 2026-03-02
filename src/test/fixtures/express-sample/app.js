const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// Router
const userRouter = express.Router();

userRouter.get('/users', async (req, res) => {
    res.json([]);
});

userRouter.post('/users', async (req, res) => {
    res.json({ status: 'created' });
});

userRouter.get('/users/:id', async (req, res) => {
    res.json({ id: req.params.id });
});

// Mount router
app.use('/api', userRouter);

// Middleware
app.use('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(3000, () => console.log('Server running'));
