import { IntegrationRepository } from './integration.repository.js';
import { IntegrationService } from './integration.service.js';

export const integrationService = new IntegrationService(new IntegrationRepository());
