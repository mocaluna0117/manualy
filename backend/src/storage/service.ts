import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fileTypeOf, mimeTypeOf } from './file-types';

/** endpointは値があるときだけ設定する(未設定ならAWS S3の既定URLが使われる) */
function withEndpoint(
  config: S3ClientConfig,
  endpoint?: string,
): S3ClientConfig {
  return endpoint ? { ...config, endpoint } : config;
}

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly presignS3: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? 'manuals';

    const accessKeyId = process.env.S3_ACCESS_KEY;
    const secretAccessKey = process.env.S3_SECRET_KEY;

    const baseConfig: S3ClientConfig = {
      region: process.env.S3_REGION ?? 'us-east-1',
      // MinIOはパス形式(host/bucket/key)のURLを使う。S3は仮想ホスト形式が既定
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      // credentialsは「明示的にキーが設定されているときだけ」渡す。
      // AWS SDK v3はcredentialsを指定すると既定の資格情報チェーンを使わなくなるため、
      // 空文字を渡すとECSタスクロール(コンテナ資格情報)が一切効かず全操作が403になる。
      // ローカル(MinIO)はキーあり / 本番(S3+タスクロール)はキーなし、で切り替わる
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    };

    // サーバー内部からの操作用(削除など)。MinIOのときだけendpointを指定
    this.s3 = new S3Client(withEndpoint(baseConfig, process.env.S3_ENDPOINT));

    // 署名付きURL生成用。コンテナ環境では「ブラウザから見えるアドレス」が
    // 内部アドレス(minio:9000)と違うため、S3_PUBLIC_ENDPOINTで上書きできる。
    // 本番のAmazon S3では両方とも未設定でよい(同じURLになる)
    this.presignS3 = new S3Client(
      withEndpoint(
        baseConfig,
        process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT,
      ),
    );
  }

  /**
   * アップロード専用の署名付きURLを発行する(15分有効)。
   * ファイル本体はフロントがこのURLへ直接PUTするので、バックエンドを経由しない
   */
  async createUploadUrl(fileName: string) {
    // パス区切り文字を除去し、UUIDで衝突を防ぐ
    const safeName = fileName.replace(/[/\\]/g, '_');
    const fileKey = `${randomUUID()}/${safeName}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      // 保存されるオブジェクトのContent-Type。署名対象はhostだけなので
      // これ自体が検証されるわけではないが、フロントが同じ値をPUTするので
      // 「Excelなのにapplication/pdfで保存される」状態を防げる
      ContentType: mimeTypeOf(fileName),
    });
    const uploadUrl = await getSignedUrl(this.presignS3, command, {
      expiresIn: 900,
    });

    return { uploadUrl, fileKey };
  }

  /** 閲覧用の署名付きURLを発行する(15分有効)。PDFはタブで開き、他は保存される */
  async createDownloadUrl(fileKey: string, fileName: string) {
    return this.signDownload(this.presignS3, fileKey, fileName);
  }

  /**
   * サービス間連携用(RAG取り込みなど)の署名付きURL。
   * コンテナ環境ではブラウザ用(localhost)と内部ネットワーク用(minio:9000)で
   * 到達できるアドレスが違うため、内部用クライアントで署名する
   */
  async createInternalDownloadUrl(fileKey: string, fileName: string) {
    return this.signDownload(this.s3, fileKey, fileName);
  }

  private signDownload(client: S3Client, fileKey: string, fileName: string) {
    const type = fileTypeOf(fileName);
    // ブラウザで開けない形式(Word/Excel/PowerPoint/メール)は、タブで開こうと
    // せずそのまま保存させる。inlineのままだと真っ白なタブが開くだけになる
    const disposition = type?.viewableInBrowser ? 'inline' : 'attachment';
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      // 日本語ファイル名はRFC5987形式でエンコードする
      ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ResponseContentType: type?.mimeType ?? 'application/octet-stream',
      // ブラウザにキャッシュさせる。PDFビューアはスクロールに応じて
      // ファイルの続きを小分けに取りに行くので、これが無いと毎回通信が発生し
      // スクロールが引っかかる。privateなので共有キャッシュには残らない。
      // 期間は署名の有効期限(15分)に合わせる
      ResponseCacheControl: 'private, max-age=900',
    });
    return getSignedUrl(client, command, { expiresIn: 900 });
  }

  /**
   * サーバーが持っているバイト列をそのまま保存する。
   *
   * マニュアルはフロントから直接PUTさせているが、チャットの添付画像は
   * base64で本文と一緒に届くので、ここで置く方が往復が少ない。
   */
  async putBytes(fileKey: string, body: Uint8Array, contentType: string) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fileKey,
        Body: body,
        ContentType: contentType,
      }),
    );
    return fileKey;
  }

  /**
   * 画像を画面に表示するための署名付きURL(15分有効)。
   *
   * createDownloadUrlはマニュアル用で、扱えない形式をダウンロードさせる
   * 作りになっている。画像はその場に出したいので別に用意する
   */
  createImageUrl(fileKey: string, contentType: string) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      ResponseContentDisposition: 'inline',
      ResponseContentType: contentType,
      ResponseCacheControl: 'private, max-age=900',
    });
    return getSignedUrl(this.presignS3, command, { expiresIn: 900 });
  }

  async deleteObject(fileKey: string) {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: fileKey }),
    );
  }
}
