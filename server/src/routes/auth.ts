import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendPasswordResetCode } from '../services/mailer.js';
import { createPasswordResetCode, resetPasswordWithCode } from '../services/password-reset.js';

import {
  userCount,
  createUser,
  verifyCredentials,
  createSession,
  validateSession,
  deleteSession,
} from '../services/auth.js';

import {
  setupCodeMatches,
  clearSetupCode,
} from '../lib/setup-code.js';

import {
  sendRegistrationCode,
} from '../services/mailer.js';

import {
  createRegistrationCode,
  verifyRegistrationCode,
} from '../services/email-verification.js';
import { getSetting } from '../db/index.js';

export const authRouter = Router();

/**
 * 登录 / 首次初始化使用
 */
const credentialsSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * 发送注册验证码使用
 */
const emailSchema = z.object({
  email: z.string().email('A valid email is required'),
});

/**
 * 普通用户注册使用
 * 必须：
 * - 邮箱
 * - 密码
 * - 6位邮箱验证码
 */
const registerSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Verification code must be 6 digits'),
});

const resetPasswordSchema = z.object({
  email: z.string().email('A valid email is required'),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Verification code must be 6 digits'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters'),
});



// ============================================================
// 登录防暴力破解
// ============================================================

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const attempts = new Map<
  string,
  {
    count: number;
    lockedUntil: number;
  }
>();

function isLockedOut(email: string): boolean {
  const attempt = attempts.get(email.toLowerCase());

  return !!attempt && attempt.lockedUntil > Date.now();
}

function recordFailure(email: string): void {
  const key = email.toLowerCase();

  const attempt = attempts.get(key) ?? {
    count: 0,
    lockedUntil: 0,
  };

  attempt.count++;

  if (attempt.count >= MAX_ATTEMPTS) {
    attempt.lockedUntil = Date.now() + LOCKOUT_MS;
    attempt.count = 0;
  }

  attempts.set(key, attempt);
}

function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase());
}


// ============================================================
// 获取登录 Token
// ============================================================

function bearer(req: Request): string | undefined {
  return (
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ??
    (req.headers['x-dashboard-token'] as string | undefined)
  );
}


// ============================================================
// 判断是否本机访问
// ============================================================

function isLoopbackRemote(req: Request): boolean {
  let addr = req.socket.remoteAddress ?? '';

  if (addr.startsWith('::ffff:')) {
    addr = addr.slice(7);
  }

  if (addr === '::1') {
    return true;
  }

  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}


// ============================================================
// 获取当前登录状态
// GET /api/auth/status
// ============================================================

authRouter.get('/status', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));

  res.json({
    needsSetup: userCount() === 0,
    authenticated: !!session,
    email: session?.email ?? null,
    role: session?.role ?? null,
  });
});


// ============================================================
// 首次初始化管理员
// POST /api/auth/setup
//
// 注意：
// 这是服务器第一次初始化管理员账号使用。
// 不要求邮箱验证码。
// 当系统已经存在用户以后，此接口自动失效。
// ============================================================

authRouter.post('/setup', (req: Request, res: Response) => {
  if (userCount() > 0) {
    clearSetupCode();

    res.status(409).json({
      error: {
        message: 'Setup already completed. Use login instead.',
        type: 'setup_complete',
      },
    });

    return;
  }

  if (
    !isLoopbackRemote(req) &&
    !setupCodeMatches((req.body ?? {}).setupCode)
  ) {
    res.status(403).json({
      error: {
        message:
          'A setup code is required to create the first account from a remote device. ' +
          'Check the server logs for the code, or open the dashboard from a browser on the machine running FreeLLMAPI.',
        type: 'setup_code_required',
      },
    });

    return;
  }

  const parsed = credentialsSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors
          .map((error) => error.message)
          .join(', '),
      },
    });

    return;
  }

  const user = createUser(
    parsed.data.email,
    parsed.data.password,
  );

  clearSetupCode();

  const token = createSession(user.userId);

  res.status(201).json({
    token,
    email: user.email,
  });
});


// ============================================================
// 登录
// POST /api/auth/login
// ============================================================

authRouter.post('/login', (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors
          .map((error) => error.message)
          .join(', '),
      },
    });

    return;
  }

  const {
    email,
    password,
  } = parsed.data;

  if (isLockedOut(email)) {
    res.status(429).json({
      error: {
        message: 'Too many failed attempts. Try again later.',
        type: 'rate_limit_error',
      },
    });

    return;
  }

  const user = verifyCredentials(
    email,
    password,
  );

  if (!user) {
    recordFailure(email);

    res.status(401).json({
      error: {
        message: 'Invalid email or password',
        type: 'authentication_error',
      },
    });

    return;
  }

  clearFailures(email);

  const token = createSession(user.userId);

  res.json({
    token,
    email: user.email,
  });
});


// ============================================================
// 发送普通用户注册验证码
// POST /api/auth/send-register-code
//
// 请求：
// {
//   "email": "user@qq.com"
// }
// ============================================================

authRouter.post(
  '/send-register-code',
  async (req: Request, res: Response) => {
    const parsed = emailSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: parsed.error.errors
            .map((error) => error.message)
            .join(', '),
          type: 'validation_error',
        },
      });

      return;
    }

    try {
      const email = parsed.data.email;

      /**
       * 生成验证码并将 Hash 写入数据库。
       * 明文验证码只在这里短暂存在。
       */
      const code = createRegistrationCode(email);

      /**
       * 通过已经配置好的 QQ SMTP 发送邮件。
       */
      await sendRegistrationCode(
        email,
        code,
      );

      res.json({
        success: true,
        message: 'Verification code sent',
      });
    } catch (err) {
      const errorCode = (
        err as {
          code?: string;
        }
      ).code;

      /**
       * 邮箱已经注册
       */
      if (errorCode === 'email_taken') {
        res.status(409).json({
          error: {
            message:
              'An account with that email already exists',
            type: 'conflict_error',
          },
        });

        return;
      }

      /**
       * 60秒内重复获取验证码
       */
      if (errorCode === 'send_cooldown') {
        res.status(429).json({
          error: {
            message:
              'Please wait 60 seconds before requesting another code',
            type: 'rate_limit_error',
          },
        });

        return;
      }

      console.error(
        '[auth] Failed to send registration code:',
        err,
      );

      res.status(500).json({
        error: {
          message:
            'Failed to send verification code',
          type: 'email_send_error',
        },
      });
    }
  },
);


// ============================================================
// 普通用户注册
// POST /api/auth/register
//
// 请求：
// {
//   "email": "user@qq.com",
//   "password": "12345678",
//   "code": "123456"
// }
//
// 没有正确验证码无法注册。
// ============================================================

authRouter.post('/register', (req: Request, res: Response) => {
  if (getSetting('registration_enabled') === '0') { res.status(403).json({ error: { message: 'Registration is currently closed', type: 'registration_disabled' } }); return; }
  const parsed = registerSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors
          .map((error) => error.message)
          .join(', '),
        type: 'validation_error',
      },
    });

    return;
  }

  const {
    email,
    password,
    code,
  } = parsed.data;

  /**
   * 第一步：
   * 验证邮箱验证码。
   *
   * 验证失败包括：
   * - 验证码错误
   * - 验证码过期
   * - 验证码已经使用
   * - 输入错误次数超过限制
   */
  const verified = verifyRegistrationCode(
    email,
    code,
  );

  if (!verified) {
    res.status(400).json({
      error: {
        message:
          'Invalid or expired verification code',
        type: 'verification_error',
      },
    });

    return;
  }

  try {
    /**
     * 第二步：
     * 验证码通过以后才能真正创建用户。
     */
    const user = createUser(
      email,
      password,
    );

    /**
     * 第三步：
     * 注册成功后自动登录。
     */
    const token = createSession(
      user.userId,
    );

    res.status(201).json({
      token,
      email: user.email,
    });
  } catch (err) {
    if (
      (err as {
        code?: string;
      }).code === 'email_taken'
    ) {
      res.status(409).json({
        error: {
          message:
            'An account with that email already exists',
          type: 'conflict_error',
        },
      });

      return;
    }

    throw err;
  }
});


// ============================================================
// 退出登录
// POST /api/auth/logout
// ============================================================


/**
 * ?????????
 * POST /api/auth/send-reset-code
 */
authRouter.post(
  '/send-reset-code',
  async (req: Request, res: Response) => {
    const parsed = emailSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: parsed.error.errors
            .map((error) => error.message)
            .join(', '),
          type: 'validation_error',
        },
      });

      return;
    }

    try {
      const email = parsed.data.email;

      const code =
        createPasswordResetCode(email);

      /*
       * ????????????
       * ??????????????
       */
      if (code) {
        await sendPasswordResetCode(
          email,
          code,
        );
      }

      res.json({
        success: true,
        message:
          'If this email is registered, a verification code has been sent.',
      });
    } catch (err) {
      const errorCode = (
        err as {
          code?: string;
        }
      ).code;

      /*
       * ????60???????????????
       * ???????????????
       */
      if (errorCode === 'send_cooldown') {
        res.json({
          success: true,
          message:
            'If this email is registered, a verification code has been sent.',
        });

        return;
      }

      console.error(
        '[auth] Failed to send password reset code:',
        err,
      );

      res.status(500).json({
        error: {
          message:
            'Failed to process password reset request',
          type: 'email_send_error',
        },
      });
    }
  },
);


/**
 * ?????????
 * POST /api/auth/reset-password
 */
authRouter.post(
  '/reset-password',
  (req: Request, res: Response) => {
    const parsed =
      resetPasswordSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: parsed.error.errors
            .map((error) => error.message)
            .join(', '),
          type: 'validation_error',
        },
      });

      return;
    }

    const {
      email,
      code,
      newPassword,
    } = parsed.data;

    const success =
      resetPasswordWithCode(
        email,
        code,
        newPassword,
      );

    if (!success) {
      res.status(400).json({
        error: {
          message:
            'Invalid or expired verification code',
          type: 'verification_error',
        },
      });

      return;
    }

    res.json({
      success: true,
      message:
        'Password reset successfully',
    });
  },
);


authRouter.post('/logout', (req: Request, res: Response) => {
  deleteSession(
    bearer(req),
  );

  res.json({
    success: true,
  });
});


// ============================================================
// 获取当前用户
// GET /api/auth/me
// ============================================================

authRouter.get('/me', (req: Request, res: Response) => {
  const session = validateSession(
    bearer(req),
  );

  if (!session) {
    res.status(401).json({
      error: {
        message: 'Authentication required',
        type: 'authentication_error',
      },
    });

    return;
  }

  res.json({
    email: session.email,
  });
});
