---
name: azure-resource-health-diagnose
description: 'Analyze Azure resource health, diagnose issues from logs and telemetry, and create a remediation plan for identified problems.'
triggers:
  - "azure-resource-health-diagnose"
  - "azure resource health diagnose"
  - "awesome copilot azure resource health diagnose"
---

# Azure Resource Health & Issue Diagnosis

This workflow analyzes a specific Azure resource to assess its health status, diagnose potential issues using logs and telemetry data, and develop a comprehensive remediation plan for any problems discovered.

## Prerequisites
- Azure MCP server configured and authenticated
- Target Azure resource identified (name and optionally resource group/subscription)
- Resource must be deployed and running to generate logs/telemetry
- Prefer Azure MCP tools (`azmcp-*`) over direct Azure CLI when available

## Workflow Steps

### Step 1: Get Azure Best Practices
**Action**: Retrieve diagnostic and troubleshooting best practices
**Tools**: Azure MCP best practices tool
**Process**:
1. **Load Best Practices**:
   - Execute Azure best practices tool to get diagnostic guidelines
   - Focus on health monitoring, log analysis, and issue resolution patterns
   - Use these practices to inform diagnostic approach and remediation recommendations

### Step 2: Resource Discovery & Identification
**Action**: Locate and identify the target Azure resource
**Tools**: Azure MCP tools + Azure CLI fallback
**Process**:
1. **Resource Lookup**:
   - If only resource name provided: Search across subscriptions using `azmcp-subscription-list`
   - Use `az resource list --name <resource-name>` to find matching resources
   - If multiple matches found, prompt user to specify subscription/resource group
   - Gather detailed resource information:
     - Resource type and current status
     - Location, tags, and configuration
     - Associated services and dependencies

2. **Resource Type Detection**:
   - Identify resource type to determine appropriate diagnostic approach:
     - **Web Apps/Function Apps**: Application logs, performance metrics, dependency tracking
     - **Virtual Machines**: System logs, performance counters, boot diagnostics
     - **Cosmos DB**: Request metrics, throttling, partition statistics
     - **Storage Accounts**: Access logs, performance metrics, availability
     - **SQL Database**: Query performance, connection logs, resource utilization
     - **Application Insights**: Application telemetry, exceptions, dependencies
     - **Key Vault**: Access logs, certificate status, secret usage
     - **Service Bus**: Message metrics, dead letter queues, throughput

### Step 3: Health Status Assessment
**Action**: Evaluate current resource health and availability
**Tools**: Azure MCP monitoring tools + Azure CLI
**Process**:
1. **Basic Health Check**:
   - Check resource provisioning state and operational status
   - Verify service availability and responsiveness
   - Review recent deployment or configuration changes
   - Assess current resource utilization (CPU, memory, storage, etc.)

2. **Service-Specific Health Indicators**:
   - **Web Apps**: HTTP response codes, response times, uptime
   - **Databases**: Connection success rate, query performance, deadlocks
   - **Storage**: Availability percentage, request success rate, latency
   - **VMs**: Boot diagnostics, guest OS metrics, network connectivity
   - **Functions**: Execution success rate, duration, error frequency

### Step 4: Log & Telemetry Analysis
**Action**: Analyze logs and telemetry to identify issues and patterns
**Tools**: Azure MCP monitoring tools for Log Analytics queries
**Process**:
1. **Find Monitoring Sources**:
   - Use `azmcp-monitor-workspace-list` to identify Log Analytics workspaces
   - Locate Application Insights instances associated with the resource
   - Identify relevant log tables using `azmcp-monitor-table-list`

2. **Execute Diagnostic Queries**:
   Use `azmcp-monitor-log-query` with targeted KQL queries based on resource type:

   **General Error Analysis**:
   ```kql
   // Recent errors and exceptions
   union isfuzzy=true 
       AzureDiagnostics,
       AppServiceHTTPLogs,
       AppServiceAppLogs,
       AzureActivity
   | where TimeGenerated > ago(24h)
   | where Level == "Error" or ResultType != "Success"
   | summarize ErrorCount=count() by Resource, ResultType, bin(TimeGenerated, 1h)
   | order by TimeGenerated desc
   ```

   **Performance Analysis**:
   ```kql
   // Performance degradation patterns
   Perf
   | where TimeGenerated > ago(7d)
   | where ObjectName == "Processor" and CounterName == "% Processor Time"
   | summarize avg(CounterValue) by Computer, bin(TimeGenerated, 1h)
   | where avg_CounterValue > 80
   ```

   **Application-Specific Queries**:
   ```kql
   // Application Insights - Failed requests
   requests
   | where timestamp > ago(24h)
   | where success == false
   | summarize FailureCount=count() by resultCode, bin(timestamp, 1h)
   | order by timestamp desc
   
   // Database - Connection failures
   AzureDiagnostics
   | where ResourceProvider == "MICROSOFT.SQL"
   | where Category == "SQLSecurityAuditEvents"
   | where action_name_s == "CONNECTION_FAILED"
   | summarize ConnectionFailures=count() by bin(TimeGenerated, 1h)
   ```

3. **Pattern Recognition**:
   - Identify recurring error patterns or anomalies
   - Correlate errors with deployment times or configuration changes
   - Analyze performance trends and degradation patterns
   - Look for dependency failures or external service issues

### Step 5: Issue Classification & Root Cause Analysis
**Action**: Categorize identified issues and determine root causes
**Process**:
1. **Issue Classification**:
   - **Critical**: Service unavailable, data loss, security breaches
   - **High**: Performance degradation, intermittent failures, high error rates
   - **Medium**: Warnings, suboptimal configuration, minor performance issues
   - **Low**: Informational alerts, optimization opportunities

2. **Root Cause Analysis**:
   - **Configuration Issues**: Incorrect settings, missing dependencies
   - **Resource Constraints**: CPU/memory/disk limitations, throttling
   - **Network Issues**: Connectivity problems, DNS resolution, firewall rules
   - **Application Issues**: Code bugs, memory leaks, inefficient queries
   - **External Dependencies**: Third-party service failures, API limits
   - **Security Issues**: Authentication failures, certificate expiration

3. **Impact Assessment**:
   - Determine business impact and affected users/systems
   - Evaluate data integrity and security implications
   - Assess recovery time objectives and priorities

### Step 6: Generate Remediation Plan
**Action**: Create a comprehensive plan to address identified issues
**Process**:
1. **Immediate Actions** (Critical issues):
   - Emergency fixes to restore service availability
   - Temporary workarounds to mitigate impact
   - Escalation procedures for complex issues

2. **Short-term Fixes** (High/Medium issues):
   - Configuration adjustments and resource scaling
   - Application updates and patches
   - Monitoring and alerting improvements

3. **Long-term Improvements** (All issues):
   - Architectural changes for better resilience
   - Preventive measures and monitoring enhancements
   - Documentation and process improvements

4. **Implementation Steps**:
   - Prioritized action items with specific Azure CLI commands
   - Testing and validation procedures
   - Rollback plans for each change
   - Monitoring to verify issue resolution

### Step 7: User Confirmation & Report Generation
**Action**: Present findings and get approval for remediation actions
**Process**:
1. **Display Health Assessment Summary**:
   ```
   🏥 Azure Resource Health Assessment
   
   📊 Resource Overview:
   • Resource: [Name] ([Type])
   • Status: [Healthy/Warning/Critical]
   • Location: [Region]
   • Last Analyzed: [Timestamp]
   
   🚨 Issues Identified:
   • Critical: X issues requiring immediate attention
   • High: Y issues affecting performance/reliability  
   • Medium: Z issues for optimization
   • Low: N informational items
   
   🔍 Top Issues:
   1. [Issue Type]: [Description] - Impact: [High/Medium/Low]
   2. [Issue Type]: [Description] - Impact: [High/Medium/Low]
   3. [Issue Type]: [Description] - Impact: [High/Medium/Low]
   
   🛠️ Remediation Plan:
   • Immediate Actions: X items
   • Short-term Fixes: Y items  
   • Long-term Improvements: Z items
   • Estimated Resolution Time: [Timeline]
   
   ❓ Proceed with detailed remediation plan? (y/n)
   ```

2. **Generate Detailed Report**:
   ```markdown
   # Azure Resource Health Report: [Resource Name]
   
   **Generated**: [Timestamp]  
   **Resource**: [Full Resource ID]  
   **Overall Health**: [Status with color indicator]
   
   ## 🔍 Executive Summary
   [Brief overview of health status and key findings]
   
   ## 📊 Health Metrics
   - **Availability**: X% over last 24h
   - **Performance**: [Average response time/throughput]
   - **Error Rate**: X% over last 24h
   - **Resource Utilization**: [CPU/Memory/Storage percentages]
   
   ## 🚨 Issues Identified
   
   ### Critical Issues
   - **[Issue 1]**: [Description]
     - **Root Cause**: [Analysis]
     - **Impact**: [Business impact]
     - **Immediate Action**: [Required steps]
   
   ### High Priority Issues  
   - **[Issue 2]**: [Description]
     - **Root Cause**: [Analysis]
     - **Impact**: [Performance/reliability impact]
     - **Recommended Fix**: [Solution steps]
   
   ## 🛠️ Remediation Plan
   
   ### Phase 1: Immediate Actions (0-2 hours)
   ```bash
   # Critical fixes to restore service
   [Azure CLI commands with explanations]
   ```
   
   ### Phase 2: Short-term Fixes (2-24 hours)
   ```bash
   # Performance and reliability improvements
   [Azure CLI commands with explanations]
   ```
   
   ### Phase 3: Long-term Improvements (1-4 weeks)
   ```bash
   # Architectural and preventive measures
   [Azure CLI commands and configuration changes]
   ```
   
   ## 📈 Monitoring Recommendations
   - **Alerts to Configure**: [List of recommended alerts]
   - **Dashboards to Create**: [Monitoring dashboard suggestions]
   - **Regular Health Checks**: [Recommended frequency and scope]
   
   ## ✅ Validation Steps
   - [ ] Verify issue resolution through logs
   - [ ] Confirm performance improvements
   - [ ] Test application functionality
   - [ ] Update monitoring and alerting
   - [ ] Document lessons learned
   
   ## 📝 Prevention Measures
   - [Recommendations to prevent similar issues]
   - [Process improvements]
   - [Monitoring enhancements]
   ```

## Error Handling
- **Resource Not Found**: Provide guidance on resource name/location specification
- **Authentication Issues**: Guide user through Azure authentication setup
- **Insufficient Permissions**: List required RBAC roles for resource access
- **No Logs Available**: Suggest enabling diagnostic settings and waiting for data
- **Query Timeouts**: Break down analysis into smaller time windows
- **Service-Specific Issues**: Provide generic health assessment with limitations noted

## Success Criteria
- ✅ Resource health status accurately assessed
- ✅ All significant issues identified and categorized
- ✅ Root cause analysis completed for major problems
- ✅ Actionable remediation plan with specific steps provided
- ✅ Monitoring and prevention recommendations included
- ✅ Clear prioritization of issues by business impact
- ✅ Implementation steps include validation and rollback procedures


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `azure-resource-health-diagnose`: Analyze Azure resource health, diagnose issues from logs and telemetry, and create a remediation plan for identified problems.
- Uses only task-relevant references/scripts/assets from this skill directory.
- Produces source-grounded, concrete output: commands, code changes, configuration, review notes, diagrams, or checklists as the source skill requires.
- Does not invent APIs, tool behavior, repository facts, cloud settings, credentials, or user/project context not present in the repo or supplied by the user.

## Output Format

Lead with the actionable result. For implementation or automation tasks, list changed files/commands and verification output. For advisory/review tasks, return concise findings or steps with relevant paths. Do not dump whole reference files; cite the file path and include only the decisive excerpt.

## Anti-Patterns

- Applying this skill outside its documented domain when a narrower skill exists.
- Fabricating project structure, APIs, credentials, external account state, or cloud resources.
- Copying large references/assets into chat instead of using targeted excerpts.
- Skipping verification after code, config, or workflow changes.
