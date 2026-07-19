import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { createConsumerApiKey, listConsumerApiKeys, revokeConsumerApiKey } from '../services/consumer-api-keys.js';

export const consumerApiKeysRouter = Router();

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });

consumerApiKeysRouter.get('/', (req, res) => {
  const userId = (req as typeof req & { user: { userId: number } }).user.userId;
  res.json({ keys: listConsumerApiKeys(getDb(), userId) });
});

consumerApiKeysRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid name' } });
    return;
  }
  const userId = (req as typeof req & { user: { userId: number } }).user.userId;
  const created = createConsumerApiKey(getDb(), userId, parsed.data.name);
  res.status(201).json({ key: created.key, ...created.record });
});

consumerApiKeysRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const userId = (req as typeof req & { user: { userId: number } }).user.userId;
  if (!Number.isInteger(id) || id <= 0 || !revokeConsumerApiKey(getDb(), id, userId)) {
    res.status(404).json({ error: { message: 'Consumer API key not found' } });
    return;
  }
  res.status(204).send();
});
