import React, { useState } from 'react';
import { type SkillConfig } from '../../data/mock';
import { scanLocalSkills } from '../../tauri/api';
import { isTauri } from '../../tauri/useTauri';

const TEMPLATES: Array<Partial<SkillConfig>> = [
  { name: 'code-review', description: 'Review code for security issues and best practices. Use when user asks for code review.', instructions: '# Code Review\n\n## Instructions\n1. 检查安全漏洞\n2. 评估性能问题\n3. 检查代码风格\n4. 给出改进建议' },
  { name: 'weekly-report', description: 'Generate a structured weekly report. Use when user asks for weekly report.', instructions: '# Weekly Report\n\n## Instructions\n1. 收集本周完成的工作\n2. 列出阻塞问题\n3. 规划下周计划' },
  { name: 'deploy', description: 'Deploy the project to production. Use when user mentions deploy.', instructions: '# Deploy\n\n## Instructions\n1. 运行测试\n2. 构建项目\n3. 部署到服务器\n4. 验证部署' },
];

interface Props {
  skills: SkillConfig[];
  onChange: (skills: SkillConfig[]) => void;
  lang: 'zh' | 'en';
}

const t = (zh: string, en: string, lang: 'zh' | 'en') => (lang === 'zh' ? zh : en);

export function SkillSection({ skills, onChange, lang }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState<Record<string, boolean>>({});
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const scanLocal = async (customPath?: string) => {
    if (!isTauri()) return;
    setScanning(true);
    setScanResult(null);
    try {
      const found = await scanLocalSkills(customPath);
      const existingNames = new Set(skills.map(s => s.name.toLowerCase()));
      const newSkills: SkillConfig[] = found
        .filter(s => !existingNames.has(s.name.toLowerCase()))
        .map(s => ({ ...s, id: `imported_${Date.now()}_${s.name}` }));
      if (newSkills.length === 0) {
        setScanResult(t('未发现新技能', 'No new skills found', lang));
      } else {
        onChange([...skills, ...newSkills]);
        setScanResult(t(`导入了 ${newSkills.length} 个技能`, `Imported ${newSkills.length} skills`, lang));
      }
    } catch (e: any) {
      setScanResult(t(`扫描失败: ${e?.message ?? e}`, `Scan failed: ${e?.message ?? e}`, lang));
    } finally {
      setScanning(false);
      setTimeout(() => setScanResult(null), 5000);
    }
  };

  const pickFolderAndScan = async () => {
    if (!isTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false });
      if (picked && typeof picked === 'string') {
        scanLocal(picked);
      }
    } catch (e) {
      console.warn('Folder picker failed:', e);
    }
  };

  const update = (id: string, patch: Partial<SkillConfig>) => {
    onChange(skills.map(s => s.id === id ? { ...s, ...patch } : s));
  };

  const addSkill = (template?: Partial<SkillConfig>) => {
    const newS: SkillConfig = {
      id: `skill_${Date.now()}`,
      name: template?.name || 'new-skill',
      description: template?.description || '',
      instructions: template?.instructions || '',
      allowedTools: [],
      enabled: true,
      ...template,
    };
    onChange([...skills, newS]);
    setExpandedId(newS.id);
  };

  const removeSkill = (id: string) => {
    onChange(skills.filter(s => s.id !== id));
  };

  const validateName = (name: string): string | null => {
    if (!name) return t('名称不能为空', 'Name required', lang);
    if (name.length > 64) return t('最多 64 字符', 'Max 64 chars', lang);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return t('只能小写字母、数字、连字符', 'lowercase+digits+hyphens only', lang);
    return null;
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--hone-surface)', borderRadius: 12, padding: 16,
    border: '1px solid var(--hone-border)', marginBottom: 12,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 8,
    background: 'var(--hone-bg)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none', boxSizing: 'border-box',
  };
  const btnStyle: React.CSSProperties = {
    padding: '7px 16px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    background: 'var(--hone-surfaceRaised)', color: 'var(--hone-text)',
    border: '1px solid var(--hone-border)', outline: 'none',
  };
  const btnAccent: React.CSSProperties = { ...btnStyle, background: 'var(--hone-accent)', color: '#fff', border: 'none' };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{t('技能', 'Skills', lang)}</h2>
        <button style={btnAccent} onClick={() => addSkill()}>{t('+ 新建', '+ New', lang)}</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--hone-muted)', marginBottom: 12 }}>
        {t('Agent Skills 规范：SKILL.md + YAML frontmatter + Markdown 指令。', 'Agent Skills spec: SKILL.md + YAML frontmatter + Markdown instructions.', lang)}
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button
          style={{ ...btnAccent, opacity: scanning ? 0.6 : 1 }}
          disabled={scanning}
          onClick={() => scanLocal()}
        >
          {scanning ? t('扫描中…', 'Scanning…', lang) : t('🔍 扫描默认路径', '🔍 Scan Default', lang)}
        </button>
        <button
          style={{ ...btnStyle, opacity: scanning ? 0.6 : 1 }}
          disabled={scanning}
          onClick={pickFolderAndScan}
        >
          {t('📁 选择文件夹', '📁 Choose Folder', lang)}
        </button>
        {scanResult && (
          <span style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{scanResult}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--hone-muted)', alignSelf: 'center' }}>{t('模板:', 'Templates:', lang)}</span>
        {TEMPLATES.map(tpl => (
          <button key={tpl.name} style={{ ...btnStyle, fontSize: 11, padding: '3px 10px' }} onClick={() => addSkill(tpl)}>{tpl.name}</button>
        ))}
      </div>

      {skills.map(s => {
        const isExpanded = expandedId === s.id;
        const nameError = validateName(s.name);
        return (
          <div key={s.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }} onClick={() => setExpandedId(isExpanded ? null : s.id)}>
                <span style={{ fontSize: 18 }}>📦</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'monospace' }}>/{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--hone-muted)' }}>{s.description.slice(0, 60) || t('无描述', 'no description', lang)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: s.enabled ? 'var(--hone-success)' : 'var(--hone-muted)' }}>
                  {s.enabled ? t('启用', 'On', lang) : t('禁用', 'Off', lang)}
                </span>
                <button style={{ ...btnStyle, padding: '4px 12px' }} onClick={() => update(s.id, { enabled: !s.enabled })}>
                  {s.enabled ? '禁用' : '启用'}
                </button>
                <button style={btnStyle} onClick={() => setExpandedId(isExpanded ? null : s.id)}>
                  {isExpanded ? t('收起', 'Collapse', lang) : t('编辑', 'Edit', lang)}
                </button>
              </div>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('名称', 'Name', lang)}</label>
                  <input style={{ ...inputStyle, borderColor: nameError ? 'var(--hone-danger)' : 'var(--hone-border)' }} value={s.name} onChange={e => update(s.id, { name: e.target.value })} />
                  {nameError && <div style={{ fontSize: 11, color: 'var(--hone-danger)', marginTop: 4 }}>{nameError}</div>}
                  <div style={{ fontSize: 11, color: 'var(--hone-muted)', marginTop: 4 }}>{t('小写字母+数字+连字符，1-64 字符', 'lowercase+digits+hyphens, 1-64 chars', lang)}</div>
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('描述', 'Description', lang)}</label>
                  <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={s.description} onChange={e => update(s.id, { description: e.target.value })} placeholder={t('说明做什么 + 什么时候用', 'What it does + when to use', lang)} />
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('指令 (Markdown)', 'Instructions (Markdown)', lang)}</label>
                  <textarea style={{ ...inputStyle, minHeight: 120, resize: 'vertical', fontFamily: 'monospace' }} value={s.instructions} onChange={e => update(s.id, { instructions: e.target.value })} />
                </div>

                <button style={{ ...btnStyle, fontSize: 12, width: 'fit-content' }} onClick={() => setShowAdvanced({ ...showAdvanced, [s.id]: !showAdvanced[s.id] })}>
                  {showAdvanced[s.id] ? t('▼ 高级', '▼ Advanced', lang) : t('▶ 高级', '▶ Advanced', lang)}
                </button>

                {showAdvanced[s.id] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 12, borderLeft: '2px solid var(--hone-border)' }}>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('许可证', 'License', lang)}</label>
                      <input style={inputStyle} value={s.license || ''} onChange={e => update(s.id, { license: e.target.value })} placeholder="MIT" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('兼容性', 'Compatibility', lang)}</label>
                      <input style={inputStyle} value={s.compatibility || ''} onChange={e => update(s.id, { compatibility: e.target.value })} placeholder="Requires Python 3.9+" />
                    </div>
                    <div>
                      <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>{t('允许工具', 'Allowed Tools', lang)}</label>
                      <input style={inputStyle} value={(s.allowedTools || []).join(' ')} onChange={e => update(s.id, { allowedTools: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="Bash(python:*) Read Write" />
                    </div>
                  </div>
                )}

                <button style={{ ...btnStyle, color: 'var(--hone-danger)', borderColor: 'var(--hone-danger)', width: 'fit-content' }} onClick={() => removeSkill(s.id)}>
                  {t('删除技能', 'Delete Skill', lang)}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
