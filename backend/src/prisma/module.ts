import { Global, Module } from '@nestjs/common';
import { PrismaService } from './service';

// @Global: 一度AppModuleに入れれば、どのモジュールからもPrismaServiceを注入できる
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
