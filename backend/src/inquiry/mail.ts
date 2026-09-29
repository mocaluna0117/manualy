/**
 * 問い合わせメールを組み立てる部分。
 *
 * NestJSやDBに触らない純粋な処理だけを置く。ここは壊れても例外が出ず
 * 「送ったのに届かない」形で表面化するので、単体で確かめられるようにしてある。
 */

/** メールアドレスの@より後ろ(小文字)。取れなければ空文字 */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * この宛先にReply-Toを付けてよいかを判定する。
 *
 * 差出人(SESで認証したアドレス)は宛先の会社とは別のドメインなので、
 * そこにReply-Toだけ宛先と同じ社内ドメインを載せると
 * 「社外から来たのに社内の人を名乗るメール」の形になる。
 * これは詐称メールの典型なので、Microsoft 365などの迷惑メール判定に
 * 引っかかって受信箱に入らない(実際にそうなった)。
 *
 * 社内ドメイン宛てのぶんだけReply-Toを外す。誰からの問い合わせかは
 * 本文の「送信者:」に必ず書いてあるので、情報は失われない。
 */
export function canReplyTo(to: string, sender: string | null): boolean {
  if (!sender) return false;
  return domainOf(to) !== domainOf(sender);
}

export function buildRawEmail({
  from,
  to,
  replyTo,
  subject,
  body,
  attachments,
}: {
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  body: string;
  attachments: { bytes: Buffer; mimeType: string; filename: string }[];
}): Buffer {
  // 区切り文字は本文と衝突しない文字列にする
  const boundary = `----manualy-${Date.now().toString(36)}`;
  const encodeHeader = (text: string) =>
    `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
  // base64は76文字ごとに改行する決まり(長い1行だと弾く受信側がある)
  const wrap = (text: string) => text.replace(/.{1,76}/g, '$&\r\n');

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(body, 'utf8').toString('base64')),
    ...attachments.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: ${a.mimeType}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      wrap(a.bytes.toString('base64')),
    ]),
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
