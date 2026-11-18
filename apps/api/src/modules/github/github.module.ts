/**
 * GitHub App module — Phase 1+2 stub.
 *
 * Full GitHub App install/callback + signed webhook handler is wired in CL-055.
 * The webhook endpoint signature verification pattern is documented in
 * docs/PHASE_1_2_BUILD_PLAN.md section 5.3.
 */
import { Module } from '@nestjs/common';
import { GithubController } from './github.controller.js';
import { GithubService } from './github.service.js';

@Module({
  controllers: [GithubController],
  providers: [GithubService],
})
export class GithubModule {}
