export const IPC = {
  agentSettingsGet: 'agent-settings:get',
  agentSettingsSave: 'agent-settings:save',
  agentConnectionTest: 'agent-settings:test',
  sourcesList: 'sources:list',
  monitorStart: 'monitor:start',
  demoStart: 'demo:start',
  monitorStop: 'monitor:stop',
  detectorAnalyze: 'detector:analyze',
  stateGet: 'state:get',
  stateUpdate: 'state:update',
  overlayDetails: 'overlay:details',
  overlayExpand: 'overlay:expand'
} as const
