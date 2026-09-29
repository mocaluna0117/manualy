import { Module } from '@nestjs/common';
import { TemplateResolver } from './resolver';
import { TemplateService } from './service';

@Module({
  providers: [TemplateService, TemplateResolver],
})
export class TemplateModule {}
