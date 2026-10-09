#!/usr/bin/env python3
"""Read public Japanese guide pages for local research; export a source inventory.
Raw research stays in ignored .runtime. Execution uses reviewed plans, never web text.
"""
import concurrent.futures, datetime, hashlib, json, re, time, urllib.request, urllib.parse
from html.parser import HTMLParser
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.runtime/guide-research'
DATA = ROOT / 'data/langrisser'
BASE = 'https://langrisser.wikiru.jp/'
INDEX = BASE + '?' + urllib.parse.quote('ゲートの彼方')
class IndexParser(HTMLParser):
    def __init__(self): super().__init__(); self.items=[]; self.item=None
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag=='a' and a.get('title','').startswith('ゲートの彼方/'):
            self.item={'page':a['title'], 'sourceUrl':urllib.parse.urljoin(BASE,a['href']), 'titleJa':''}
    def handle_data(self, data):
        if self.item is not None: self.item['titleJa'] += data
    def handle_endtag(self, tag):
        if tag=='a' and self.item is not None: self.items.append(self.item); self.item=None
class BodyParser(HTMLParser):
    def __init__(self): super().__init__(); self.depth=0; self.parts=[]; self.skip=0
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='div':
            if self.depth: self.depth+=1
            elif a.get('id')=='body': self.depth=1
        if not self.depth:return
        if tag in ('script','style'): self.skip+=1
        if tag in ('br','p','li','h2','h3','h4','tr'):self.parts.append('\n')
        if tag in ('td','th'):self.parts.append(' | ')
    def handle_endtag(self,tag):
        if tag=='div' and self.depth:self.depth-=1
        if tag in ('script','style') and self.skip:self.skip-=1
        if self.depth and tag in ('p','li','h2','h3','h4','tr'):self.parts.append('\n')
    def handle_data(self,data):
        if self.depth and not self.skip:self.parts.append(data)
    def text(self):
        text=''.join(self.parts)
        # First occurrence can be a table-of-contents link; last is the comments section.
        if 'コメントフォーム' in text:text=text[:text.rfind('コメントフォーム')]
        return '\n'.join(line.strip(' \t↑†') for line in text.splitlines() if line.strip(' \t↑†'))
def get(url):
    req=urllib.request.Request(url,headers={'User-Agent':'LangrisserGuideResearch/0.1 (personal offline strategy notes)'})
    with urllib.request.urlopen(req,timeout=30) as r:return r.read().decode('utf-8')
def fetch(item):
    key=item['page'].split('/',1)[1]
    ident=key.replace('本編','main-').replace('黎明の序章','side1-').replace('追憶の基点','side3-').replace('暁の記憶','side4-')
    if ident.startswith('2-'):ident='side'+ident
    out={**item,'id':ident,'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'executionStatus':'unmapped'}
    try:
        cache=CACHE/(ident+'.txt')
        if cache.exists():text=cache.read_text()
        else:
            html=get(item['sourceUrl']);parser=BodyParser();parser.feed(html);text=parser.text()
            if len(text)<20 or '攻略' not in text and '会話' not in text:raise ValueError('stage body unavailable')
            cache.write_text(text);time.sleep(0.3)
        out['sourceStatus']='read'
        out['sourceSha256']=hashlib.sha256(text.encode()).hexdigest()
        m=re.search(r'ターン制限[：:]\s*(\d+)',text)
        out['turnLimit']=int(m[1]) if m else None
        # Guides use both "3T:" and "T3:" notation; recognize either order.
        out['hasTurnInstructions']=bool(re.search(r'(?:\d+ターン目|[１２３４５６７８９１]+ターン目|\d+T[：:]|T\d+[：:])',text))
        out['researchCharacters']=len(text)
    except Exception as e:out['sourceStatus']='unavailable';out['error']=str(e)
    return out
if __name__=='__main__':
    CACHE.mkdir(parents=True,exist_ok=True);DATA.mkdir(parents=True,exist_ok=True)
    index=CACHE/'index.html'
    if not index.exists():index.write_text(get(INDEX))
    p=IndexParser();p.feed(index.read_text());items=list({i['page']:i for i in p.items}.values())
    result=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        for item in ex.map(fetch,items):
            result.append(item)
            print(f"{len(result)}/{len(items)} {item['id']} {item['sourceStatus']}",flush=True)
    inventory={'sourceIndex':INDEX,'scope':'일본어 위키 목차에서 확인된 스테이지. 한국 서버 전체와의 일치 여부는 게임에서 확인 필요.', 'stages':result}
    (DATA/'sources.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
