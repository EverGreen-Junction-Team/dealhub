import apiClient from './client'

const enc = encodeURIComponent
// 'project' → 'projects'; the server routes by the plural.
const path = (kind) => (kind === 'remedial' ? 'remedials' : 'projects')

// Operations Hub, slice 1. See docs/operations-hub-plan.md and
// server/src/routes/operations.js. A job is a GHL opportunity in the mapped
// Operations or Remedials pipeline; everything else is Deal Hub's.
// Fired on window when the Control panel switches the Operations Hub on or
// off for this sub-account (detail: true/false); the shell's menu follows.
export const OPS_ENABLED_EVENT = 'pp:ops-enabled'

export const opsAPI = {
  // Whether THIS sub-account has the Operations Hub (Control panel switch).
  // The only ops routes that answer while it is off.
  enabled: () => apiClient.get('/api/ops/enabled'),
  setEnabled: (enabled) => apiClient.put('/api/ops/enabled', { enabled }),

  settings: () => apiClient.get('/api/ops/settings'),
  // A Deal Hub setting — choosing pipelines changes nothing in GHL.
  saveSettings: (body) => apiClient.put('/api/ops/settings', body),
  // What the client has and has not decided yet (Q1, Q2, Q4).
  decisions: () => apiClient.get('/api/ops/decisions'),

  list: (kind, params = {}) => apiClient.get(`/api/ops/${path(kind)}`, { params }),
  get: (kind, id) => apiClient.get(`/api/ops/${path(kind)}/${enc(id)}`),
  update: (kind, id, patch) => apiClient.patch(`/api/ops/${path(kind)}/${enc(id)}`, patch),
  // A GHL write: moves the opportunity to that stage.
  moveStage: (kind, id, stageKey) => apiClient.put(`/api/ops/${path(kind)}/${enc(id)}/stage`, { stageKey }),
  logRemedial: (body) => apiClient.post('/api/ops/remedials', body),

  addStep: (kind, id, body) => apiClient.post(`/api/ops/${path(kind)}/${enc(id)}/steps`, body),
  // { done } ticking the last open step of the current stage moves the job on;
  // the answer says so in advancedTo / advanceError.
  updateStep: (stepId, patch) => apiClient.patch(`/api/ops/steps/${enc(stepId)}`, patch),
  removeStep: (stepId) => apiClient.delete(`/api/ops/steps/${enc(stepId)}`),

  time: (kind, id) => apiClient.get(`/api/ops/${path(kind)}/${enc(id)}/time`),
  addTime: (kind, id, body) => apiClient.post(`/api/ops/${path(kind)}/${enc(id)}/time`, body),
  updateTime: (entryId, patch) => apiClient.patch(`/api/ops/time/${enc(entryId)}`, patch),
  removeTime: (entryId) => apiClient.delete(`/api/ops/time/${enc(entryId)}`),

  tasks: (params = {}) => apiClient.get('/api/ops/tasks', { params }),
  // A GHL task on the job's contact, linked to the job in Deal Hub.
  addTask: (kind, id, body) => apiClient.post(`/api/ops/${path(kind)}/${enc(id)}/tasks`, body),
  linkTask: (taskId, job, stageKey) => apiClient.put(`/api/ops/tasks/${enc(taskId)}/job`, { job, stageKey })
}
