import { Controller, Get } from '@nestjs/common';

// Bare liveness check — the real multi-component /health endpoint is
// Phase 5's job (Revision 1 §13). This just proves the process is up.
@Controller()
export class AppController {
  @Get()
  root() {
    return { status: 'ok', service: 'trading-monitor-backend' };
  }
}
