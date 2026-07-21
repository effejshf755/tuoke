import crypto from 'node:crypto';
import type { Db } from '../db/types.js';

type AlipayConfig = {
  appId: string;
  privateKey: string;
  publicKey: string;
  gateway: string;
  notifyUrl: string;
  returnUrl: string;
};

function normalizePem(value: string): string {
  const text = value.replace(/\\n/g, '\n').replace(/\\r/g, '').trim();
  const match = text.match(/-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/);
  if (!match) return text;
  const body = match[2].replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${match[1]}-----\n${lines}\n-----END ${match[1]}-----`;
}

function cfg(): AlipayConfig | null {
  const appId = process.env.ALIPAY_APP_ID?.trim();
  const privateKey = process.env.ALIPAY_PRIVATE_KEY ? normalizePem(process.env.ALIPAY_PRIVATE_KEY) : undefined;
  const publicKey = process.env.ALIPAY_PUBLIC_KEY ? normalizePem(process.env.ALIPAY_PUBLIC_KEY) : undefined;
  if (!appId || !privateKey || !publicKey) return null;
  return {
    appId,
    privateKey,
    publicKey,
    gateway: process.env.ALIPAY_GATEWAY?.trim() || 'https://openapi.alipay.com/gateway.do',
    notifyUrl: process.env.ALIPAY_NOTIFY_URL?.trim() || '',
    returnUrl: process.env.ALIPAY_RETURN_URL?.trim() || '',
  };
}

function sign(params: Record<string, string>, privateKey: string): string {
  const content = Object.keys(params).filter((key) => key !== 'sign' && params[key] !== '').sort().map((key) => `${key}=${params[key]}`).join('&');
  return crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(privateKey, 'base64');
}

export function verifyNotify(params: Record<string, string>): boolean {
  const config = cfg();
  if (!config || !params.sign) return false;
  const content = Object.keys(params).filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== '').sort().map((key) => `${key}=${params[key]}`).join('&');
  return crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(config.publicKey, params.sign, 'base64');
}

export function isAlipayConfigured(): boolean { return cfg() !== null; }

function buildRequest(method: string, bizContent: Record<string, unknown>, options: { notify?: boolean; returnUrl?: boolean } = {}) {
  const config = cfg();
  if (!config) throw new Error('Alipay is not configured');
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'UTF-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  if (options.notify && config.notifyUrl) params.notify_url = config.notifyUrl;
  if (options.returnUrl && config.returnUrl) params.return_url = config.returnUrl;
  params.sign = sign(params, config.privateKey);
  const gateway = new URL(config.gateway);
  gateway.searchParams.set('charset', 'UTF-8');
  return { gateway: gateway.toString(), params };
}

export function createPagePayment(orderNo: string, amountMicro: number, subject: string) {
  return buildRequest('alipay.trade.page.pay', { out_trade_no: orderNo, product_code: 'FAST_INSTANT_TRADE_PAY', total_amount: (amountMicro / 1_000_000).toFixed(2), subject }, { notify: true, returnUrl: true });
}

/** Atomically credits a paid recharge. Safe to call repeatedly for one order. */
export function settleAlipayOrder(db: Db, orderNo: string, tradeNo: string, note = 'Alipay payment') {
  return db.transaction(() => {
    const order = db.prepare('SELECT id, user_id userId, amount_micro amountMicro, status FROM recharge_orders WHERE order_no = ?').get(orderNo) as { id: number; userId: number; amountMicro: number; status: string } | undefined;
    if (!order) return { status: 'not_found' as const };
    if (order.status === 'paid') return { status: 'already_paid' as const };
    if (order.status !== 'pending') return { status: 'invalid_state' as const, currentStatus: order.status };
    const user = db.prepare('SELECT balance_micro balanceMicro FROM users WHERE id = ?').get(order.userId) as { balanceMicro: number } | undefined;
    if (!user) throw new Error('Recharge order user not found');
    const balance = user.balanceMicro + order.amountMicro;
    const updated = db.prepare("UPDATE recharge_orders SET status='paid', payment_provider='alipay', provider_trade_no=?, note=?, paid_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='pending'").run(tradeNo, note, order.id);
    if (updated.changes !== 1) return { status: 'already_paid' as const };
    db.prepare('UPDATE users SET balance_micro = ? WHERE id = ?').run(balance, order.userId);
    db.prepare("INSERT INTO wallet_transactions (user_id, type, delta_micro, balance_after_micro, note) VALUES (?, 'recharge', ?, ?, ?)").run(order.userId, order.amountMicro, balance, `Alipay recharge ${orderNo}`);
    return { status: 'paid' as const, amountMicro: order.amountMicro, balanceAfterMicro: balance };
  })();
}
