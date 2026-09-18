resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.location
}

# Pay-as-you-go storage account hosting the incidents / status_history / meta tables.
resource "azurerm_storage_account" "tables" {
  name                     = local.storage_account_name
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  https_traffic_only_enabled = true
  min_tls_version          = "TLS1_2"
}

output "tables_connection_string" {
  value     = azurerm_storage_account.tables.primary_connection_string
  sensitive = true
}

output "tables_endpoint" {
  value = azurerm_storage_account.tables.primary_table_endpoint
}

# Consumption plan for the Functions app (free-tier grant covers ~1M executions/mo).
resource "azurerm_service_plan" "functions" {
  name                = "${var.resource_group_name}-func-plan"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  os_type             = "Linux"
  sku_name            = "Y1"
  worker_count        = 1
}

resource "azurerm_linux_function_app" "app" {
  name                       = local.function_app_name
  resource_group_name        = azurerm_resource_group.rg.name
  location                   = azurerm_resource_group.rg.location
  service_plan_id            = azurerm_service_plan.functions.id
  storage_account_name       = azurerm_storage_account.tables.name
  storage_account_access_key = azurerm_storage_account.tables.primary_access_key
  functions_extension_version = "~4"

  site_config {}

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME         = "node"
    AZURE_TABLES_CONNECTION_STRING   = azurerm_storage_account.tables.primary_connection_string
    ALLOWED_ORIGIN                   = "https://${local.static_site_name}.azurestaticapps.net"
  }
}

output "function_app_name" {
  value = local.function_app_name
}

output "function_app_url" {
  value = "https://${local.function_app_name}.azurewebsites.net"
}

# Static Web App serving web/ (Leaflet map). Free tier; the plan is built into the
# resource in provider >= 4.x, no separate App Service plan needed.
resource "azurerm_static_web_app" "web" {
  name                = local.static_site_name
  resource_group_name = azurerm_resource_group.rg.name
  # Static Web Apps are unavailable in eastus; nearest supported region is eastus2.
  location            = var.swa_location
  sku_tier            = "Free"
  sku_size            = "Free"

  # Deployments go through the SWA CLI with the api key, which mutates these in
  # Azure without any Terraform change (see provider docs).
  lifecycle {
    ignore_changes = [repository_branch, repository_url]
  }
}

output "static_site_url" {
  value = "https://${local.static_site_name}.azurestaticapps.net"
}

# Deploy token consumed by the GitHub Actions static-web-apps-deploy action.
output "static_site_api_key" {
  value     = azurerm_static_web_app.web.api_key
  sensitive = true
}
