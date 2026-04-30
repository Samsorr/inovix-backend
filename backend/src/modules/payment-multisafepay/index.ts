import { ModuleProviderExports } from "@medusajs/framework/types"
import MultisafepayPaymentProviderService from "./service"

const services = [MultisafepayPaymentProviderService]

const providerExport: ModuleProviderExports = {
  services,
}

export default providerExport
export { MultisafepayPaymentProviderService }
export { MultisafepayClient } from "./client"
export * from "./types"
