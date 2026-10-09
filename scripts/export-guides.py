#!/usr/bin/env python3
"""Build reviewed Korean offline notes; raw articles are not published."""
import json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data/langrisser'
inventory=json.loads((DATA/'sources.json').read_text())
notes={}
for line in (DATA/'strategy-notes.tsv').read_text().splitlines():
    if line.startswith('#') or not line.strip():continue
    ident,note=line.split('|',1)
    if ident in notes:raise ValueError('duplicate '+ident)
    notes[ident]=note
stages=[]
for source in inventory['stages']:
    ident=source['id'];raw=(ROOT/'.runtime/guide-research'/f'{ident}.txt').read_text()
    if ident not in notes:raise ValueError('missing '+ident)
    def fact(pattern):
        found=re.search(pattern,raw,re.M)
        return found[1].strip() if found else None
    note=notes[ident]
    achievement_fact=fact(r'^実績[：:]\s*(.+)$')
    achievement_number=re.match(r'^(\d+)',achievement_fact or '')
    achievement_count=int(achievement_number[1]) if achievement_number else (0 if achievement_fact == 'なし' else None)
    treasure_fact=fact(r'^隠し宝[：:]\s*(.+)$')
    no_tactics=bool(re.search(r'(?:해법|순서|경로).*(?:없|불명)',note))
    stage={**source,'summaryKo':note,
      'treasureJa':treasure_fact,
      'treasureAvailability':'none' if treasure_fact == 'なし' else ('present' if treasure_fact else 'unknown'),
      'achievementCount':achievement_count,
      'achievementTurnTarget':int(fact(r'実績\s*(\d+)ターン') or 0) or None,
      'guideDetail':'facts-only' if no_tactics else 'strategy-notes',
      'executionStatus':'needs-screen-mapping','verifiedClear':False,'recipe':None}
    stages.append(stage)
result={'version':1,'sourceIndex':inventory['sourceIndex'],
 'coverage':{'indexedStages':len(stages),'reviewedStages':len(stages),'verifiedAutomaticClears':0,'catalogVerified':False,
 'scope':'위키 목차의 외전 4장과 본편 8장. 한국 서버 전체 목록 대조는 아직 필요.',
 'knownGaps':['목차 추가 일정에 본편 9~11장이 있으나 개별 공략 링크는 목차에 없음.','일부 문서에 턴별 해법이 없음.','모든 전투의 한국어 UI·좌표 매핑 및 자동 완주 검증 필요.']},'stages':stages}
(DATA/'guides.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
lines=['# 문 너머 저편 — 로컬 공략 노트','',f'일본어 위키 목차 {len(stages)}개 스테이지의 한국어 요약. 원문 전체의 복제본이 아닌 실행 준비용 전략 노트입니다.','',
'**자동 완주 검증: 0개.** 공략 확보와 자동 조작 검증은 별개입니다. 본편 9~11장은 목차에 개별 공략 링크가 없어 추가 조사가 필요합니다.','']
for stage in stages:
    count=stage['achievementCount'] if stage['achievementCount'] is not None else '미상'
    treasure={'none':'없음(원문 기준)','present':'있음 — 실제 수집 수 확인 필요','unknown':'미상'}[stage['treasureAvailability']]
    lines += [f"## {stage['id']} · {stage['titleJa']}",'',f"[일본어 원문]({stage['sourceUrl']})",'',stage['summaryKo'],'',f"턴 제한: {stage['turnLimit'] or '원문 확인 필요'} · 업적 수: {count} · 업적 턴 목표: {stage['achievementTurnTarget'] or '별도 확인'} · 상자/숨겨진 보물: {treasure} · 실행: 화면 매핑 필요",'']
(ROOT/'docs/LANGRISSER-GUIDES.md').write_text('\n'.join(lines))
print(json.dumps(result['coverage'],ensure_ascii=False,indent=2))
