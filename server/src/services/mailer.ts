import nodemailer from 'nodemailer';

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function createMailer() {
  const host = getRequiredEnv('SMTP_HOST');
  const user = getRequiredEnv('SMTP_USER');
  const pass = getRequiredEnv('SMTP_PASS');

  const port = Number(process.env.SMTP_PORT || '587');

  const secure =
    (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  return {
    transporter: nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    }),

    from:
      process.env.SMTP_FROM?.trim() ||
      user,
  };
}

/**
 * 发送注册验证码
 */
export async function sendRegistrationCode(
  to: string,
  code: string,
): Promise<void> {
  const {
    transporter,
    from,
  } = createMailer();

  await transporter.sendMail({
    from,
    to,

    subject: 'Tuoke API 注册验证码',

    text: [
      '您的 Tuoke API 注册验证码是：',
      '',
      code,
      '',
      '验证码 5 分钟内有效。',
      '如果不是您本人操作，请忽略此邮件。',
    ].join('\n'),

    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Tuoke API 注册验证码</h2>

        <p>您的注册验证码是：</p>

        <p style="
          font-size: 30px;
          font-weight: bold;
          letter-spacing: 6px;
        ">
          ${code}
        </p>

        <p>验证码 5 分钟内有效。</p>

        <p>
          如果不是您本人操作，请忽略此邮件。
        </p>
      </div>
    `,
  });
}

/**
 * 发送找回密码验证码
 */
export async function sendPasswordResetCode(
  to: string,
  code: string,
): Promise<void> {
  const {
    transporter,
    from,
  } = createMailer();

  await transporter.sendMail({
    from,
    to,

    subject: 'Tuoke API 找回密码验证码',

    text: [
      '您正在重置 Tuoke API 账号密码。',
      '',
      `验证码：${code}`,
      '',
      '验证码 5 分钟内有效。',
      '请勿将验证码告诉任何人。',
      '如果不是您本人操作，请忽略此邮件。',
    ].join('\n'),

    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Tuoke API 找回密码</h2>

        <p>
          您正在重置 Tuoke API 账号密码。
        </p>

        <p>验证码是：</p>

        <p style="
          font-size: 30px;
          font-weight: bold;
          letter-spacing: 6px;
        ">
          ${code}
        </p>

        <p>
          验证码 5 分钟内有效。
        </p>

        <p>
          请勿将验证码告诉任何人。
        </p>

        <p>
          如果不是您本人操作，请忽略此邮件。
        </p>
      </div>
    `,
  });
}