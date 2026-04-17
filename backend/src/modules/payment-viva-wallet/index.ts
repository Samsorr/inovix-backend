import { ModuleProviderExports } from "@medusajs/framework/types"
import VivaPaymentProviderService from "./service"

const services = [VivaPaymentProviderService]

const providerExport: ModuleProviderExports = {
  services,
}

export default providerExport
export { VivaPaymentProviderService }
export * from "./types"
