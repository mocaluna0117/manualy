import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// @Public() を付けたQuery/Mutationは認証なしでアクセスできる(ヘルスチェック用)
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
