import { MetaRepository } from './meta.repository.js';
import { MetaService } from './meta.service.js';
import { MetaApiService } from './shared/meta-api.service.js';
import { MetaAuthService } from './shared/meta-auth.service.js';

const metaRepository = new MetaRepository();
const metaApiService = new MetaApiService(metaRepository);
const metaAuthService = new MetaAuthService(metaRepository, metaApiService);

export const metaService = new MetaService(metaRepository, metaAuthService, metaApiService);
