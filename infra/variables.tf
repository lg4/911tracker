variable "location" {
  description = "Azure region for all resources."
  type        = string
  default     = "eastus"
}

# Static Web Apps are not offered in every region (notably absent from eastus);
# eastus2 is the nearest supported region to the rest of the stack.
variable "swa_location" {
  description = "Azure region for the Static Web App only."
  type        = string
  default     = "eastus2"
}

variable "resource_group_name" {
  description = "Resource group name."
  type        = string
  default     = "oneida911"
}

# Globally-unique suffix so we never collide with existing Azure names.
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  storage_account_name = "o911ts${random_string.suffix.result}"
  function_app_name    = "o911func-${random_string.suffix.result}"
  static_site_name     = "o911map-${random_string.suffix.result}"
}
