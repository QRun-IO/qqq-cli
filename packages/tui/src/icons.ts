/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Material icon names (what the web draws on app cards) as one terminal glyph, with an ASCII
 * stand-in under the ASCII-glyphs setting. Unknown names give nothing (no raw icon names on cards).
 * The glyphs are single-width text symbols, not emoji, so columns stay aligned.
 */

const GROUPS: Array<{ names: string[]; unicode: string; ascii: string }> = [
  { names: ['notifications', 'notifications_active', 'notifications_none', 'campaign', 'alarm', 'warning', 'report_problem', 'error'], unicode: '⍾', ascii: '!' },
  { names: ['insights', 'analytics', 'bar_chart', 'show_chart', 'query_stats', 'monitoring', 'trending_up', 'leaderboard', 'pie_chart', 'timeline', 'speed'], unicode: '▟', ascii: '#' },
  { names: ['storage', 'database', 'dns', 'dataset', 'table_chart', 'table_view', 'inventory', 'inventory_2'], unicode: '⛁', ascii: '=' },
  { names: ['person', 'people', 'group', 'groups', 'emoji_people', 'badge', 'account_circle', 'contacts', 'supervisor_account', 'person_outline', 'face'], unicode: '☺', ascii: '@' },
  { names: ['settings', 'admin_panel_settings', 'tune', 'build', 'construction', 'manage_accounts', 'settings_applications', 'engineering'], unicode: '⚙', ascii: '*' },
  { names: ['search', 'manage_search', 'find_in_page', 'travel_explore'], unicode: '⌕', ascii: '?' },
  { names: ['stars', 'star', 'grade', 'favorite', 'bookmark', 'bookmarks'], unicode: '★', ascii: '*' },
  { names: ['storefront', 'store', 'shopping_cart', 'sell', 'local_mall', 'point_of_sale', 'attach_money', 'payments', 'receipt', 'receipt_long'], unicode: '$', ascii: '$' },
  { names: ['location_city', 'place', 'map', 'location_on', 'public', 'home_work', 'apartment', 'business'], unicode: '⌖', ascii: '+' },
  { names: ['folder', 'folder_shared', 'folder_open', 'description', 'article', 'attach_file', 'cloud_upload', 'upload_file', 'file_copy', 'snippet_folder'], unicode: '▤', ascii: '/' },
  { names: ['terminal', 'code', 'integration_instructions', 'data_object', 'developer_mode'], unicode: '❯', ascii: '>' },
  { names: ['verified_user', 'security', 'lock', 'shield', 'policy', 'gpp_good', 'key', 'vpn_key'], unicode: '⛨', ascii: '%' },
  { names: ['hub', 'device_hub', 'share', 'lan', 'account_tree', 'swap_horiz', 'sync_alt', 'cable', 'sensors'], unicode: '✲', ascii: '&' },
  { names: ['help', 'help_outline', 'info', 'live_help', 'quiz', 'support'], unicode: '?', ascii: '?' },
  { names: ['play_circle', 'play_arrow', 'play_circle_outline', 'rocket_launch', 'bolt', 'flash_on'], unicode: '▶', ascii: '>' },
  { names: ['pending_actions', 'schedule', 'event', 'calendar_month', 'calendar_today', 'today', 'history', 'update', 'access_time', 'work_history'], unicode: '◷', ascii: ':' },
  { names: ['widgets', 'dashboard', 'apps', 'view_module', 'grid_view', 'space_dashboard'], unicode: '▦', ascii: '#' },
  { names: ['mail', 'email', 'inbox', 'forum', 'chat', 'message', 'comment', 'question_answer'], unicode: '✉', ascii: '@' },
  { names: ['bug_report', 'pest_control', 'science', 'fact_check', 'rule', 'task_alt', 'checklist', 'done_all'], unicode: '✓', ascii: 'v' },
  { names: ['local_shipping', 'shipping', 'warehouse', 'factory', 'precision_manufacturing'], unicode: '▣', ascii: '[' },
]

const BY_NAME = new Map<string, { unicode: string; ascii: string }>()
for (const g of GROUPS) for (const n of g.names) BY_NAME.set(n, g)

/** The glyph for a Material icon name, or undefined when it is not one of the common ones. */
export function iconGlyph(name: string | undefined | null, ascii: boolean): string | undefined {
  if (!name) return undefined
  const g = BY_NAME.get(name.trim().toLowerCase().replace(/[-\s]+/g, '_').replace(/_(outlined|rounded|sharp|two_tone)$/, ''))
  return g ? (ascii ? g.ascii : g.unicode) : undefined
}
