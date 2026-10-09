#!/usr/bin/env python3
"""Build the local Mac app; the existing workspace and Node runtime are required."""
import pathlib, plistlib, shutil, subprocess
root = pathlib.Path(__file__).resolve().parents[1]
app = root / 'dist' / 'Langrisser Pilot.app'
mac = app / 'Contents' / 'MacOS'
mac.mkdir(parents=True,exist_ok=True)
info = {'CFBundleIdentifier':'local.auto-game.langrisser-pilot', 'CFBundleName':'Langrisser Pilot',
        'CFBundleExecutable':'LangrisserPilot','CFBundlePackageType':'APPL','CFBundleVersion':'1',
        'LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True,
        'PilotProject':str(root),'PilotNode':shutil.which('node')}
with (app/'Contents'/'Info.plist').open('wb') as f: plistlib.dump(info,f)
subprocess.run(['xcrun','swiftc',str(root/'native/ActivateGame.swift'),'-o',str(root/'.runtime/activate-game'),'-module-cache-path',str(root/'.runtime/swift-module-cache')],check=True)
subprocess.run(['xcrun','swiftc','-parse-as-library','-D','PILOT_APP',str(root/'native/GameBridge.swift'),str(root/'native/PilotUI.swift'),'-o',str(mac/'LangrisserPilot'),'-module-cache-path',str(root/'.runtime/swift-module-cache')],check=True)
subprocess.run(['codesign','--force','--sign','-',str(app)],check=True)
print(app)
