import { buildRawEmail, canReplyTo, domainOf } from './mail';

/**
 * 問い合わせメールの組み立て。
 *
 * ここは壊れても例外が出ず、「送ったのに届かない」形で表面化する。
 * 実際に一度そうなった(添付を付けた瞬間にSESの権限が変わり全滅、
 * 社内ドメイン宛てのReply-Toが迷惑メール判定を招いた)ので、
 * 組み上がる形そのものを固定しておく。
 */
describe('buildRawEmail', () => {
  const base = {
    from: 'sender@example.com',
    to: 'to@example.com',
    replyTo: null,
    subject: 'テスト件名',
    body: '本文です',
    attachments: [],
  };

  const text = (buf: Buffer) => buf.toString('utf8');

  it('宛先と差出人がヘッダに入る', () => {
    const mail = text(buildRawEmail(base));
    expect(mail).toContain('From: sender@example.com');
    expect(mail).toContain('To: to@example.com');
  });

  it('日本語の件名はUTF-8のbase64で符号化する', () => {
    const mail = text(buildRawEmail(base));
    const encoded = Buffer.from('テスト件名', 'utf8').toString('base64');
    expect(mail).toContain(`Subject: =?UTF-8?B?${encoded}?=`);
    // 生のまま入れると文字化けするので、素の日本語は現れない
    expect(mail).not.toContain('Subject: テスト件名');
  });

  it('Reply-Toは指定したときだけ入る', () => {
    expect(text(buildRawEmail(base))).not.toContain('Reply-To:');
    expect(
      text(buildRawEmail({ ...base, replyTo: 'user@example.com' })),
    ).toContain('Reply-To: user@example.com');
  });

  it('改行はCRLF(メールの決まり)', () => {
    const mail = text(buildRawEmail(base));
    expect(mail).toContain('\r\n');
    expect(mail.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('添付が無いときも本文の区切りは正しく閉じる', () => {
    const mail = text(buildRawEmail(base));
    const boundary = /boundary="(.+)"/.exec(mail)?.[1];
    expect(boundary).toBeDefined();
    expect(mail.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('添付を複数付けると、それぞれが別の部品になる', () => {
    const mail = text(
      buildRawEmail({
        ...base,
        attachments: [
          {
            bytes: Buffer.from('one'),
            mimeType: 'image/png',
            filename: 'screenshot-1.png',
          },
          {
            bytes: Buffer.from('two'),
            mimeType: 'image/jpeg',
            filename: 'screenshot-2.jpg',
          },
        ],
      }),
    );
    expect(mail).toContain(
      'Content-Disposition: attachment; filename="screenshot-1.png"',
    );
    expect(mail).toContain(
      'Content-Disposition: attachment; filename="screenshot-2.jpg"',
    );
    expect(mail).toContain('Content-Type: image/png');
    expect(mail).toContain('Content-Type: image/jpeg');
    // 本文1つ + 添付2つ = 区切りは3回、加えて終端が1回
    const boundary = /boundary="(.+)"/.exec(mail)?.[1] as string;
    const opens = mail.split(`--${boundary}\r\n`).length - 1;
    expect(opens).toBe(3);
  });

  it('添付の中身はbase64で入り、76文字ごとに折り返す', () => {
    const bytes = Buffer.alloc(300, 0x41); // base64にすると400文字になる
    const mail = text(
      buildRawEmail({
        ...base,
        attachments: [{ bytes, mimeType: 'image/png', filename: 'big.png' }],
      }),
    );
    const encoded = bytes.toString('base64');
    expect(mail).toContain(encoded.slice(0, 76));
    // 折り返さずに入っていないこと(長い1行を弾く受信側がある)
    expect(mail).not.toContain(encoded);
    for (const line of mail.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});

/**
 * Reply-Toを付けてよいかの判定。
 *
 * 差出人(社外のGmail)のまま、返信先だけ宛先と同じ社内ドメインにすると
 * 「社外から来たのに社内の人を名乗るメール」になり、
 * Microsoft 365の迷惑メール判定で受信箱に入らなくなる(実際に起きた)。
 */
describe('canReplyTo', () => {
  const WORK = 'kimura@example-corp.co.jp';
  const GMAIL = 'someone@gmail.com';

  it('宛先と送信者が同じドメインなら付けない', () => {
    expect(canReplyTo(WORK, WORK)).toBe(false);
    expect(canReplyTo(WORK, 'tanaka@example-corp.co.jp')).toBe(false);
  });

  it('ドメインが違えば付ける', () => {
    expect(canReplyTo(GMAIL, WORK)).toBe(true);
    expect(canReplyTo(WORK, GMAIL)).toBe(true);
  });

  it('大文字小文字は区別しない', () => {
    expect(canReplyTo(WORK, 'KIMURA@EXAMPLE-CORP.CO.JP')).toBe(false);
  });

  it('ログインしていない場合は付けない', () => {
    expect(canReplyTo(WORK, null)).toBe(false);
  });

  it('似ているだけの別ドメインには付ける', () => {
    // example-corp.jp と example-corp.co.jp は別物
    expect(canReplyTo(WORK, 'kimura@example-corp.jp')).toBe(true);
  });
});

describe('domainOf', () => {
  it('@より後ろを小文字で返す', () => {
    expect(domainOf('A@Example.COM')).toBe('example.com');
  });

  it('@が複数あっても最後のものを見る', () => {
    expect(domainOf('"a@b"@example.com')).toBe('example.com');
  });
});
