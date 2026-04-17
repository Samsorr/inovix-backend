import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { IApiKeyModuleService, Logger } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger: Logger = req.scope.resolve('logger');
  try {
    const apiKeyModuleService: IApiKeyModuleService = req.scope.resolve(Modules.API_KEY);
    const apiKeys = await apiKeyModuleService.listApiKeys();
    const defaultApiKey = apiKeys.find((apiKey) => apiKey.title === 'Webshop');
    if (!defaultApiKey) {
      res.json({});
    } else {
      res.json({ publishableApiKey: defaultApiKey.token });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`key-exchange: ${message}`);
    res.status(500).json({ error: 'Failed to retrieve API key' });
  }
}