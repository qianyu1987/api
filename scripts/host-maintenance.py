#!/usr/bin/env python3
"""Relay-only storage maintenance. Dry run unless --apply; no global prune."""
import argparse
import datetime
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time

BACKUPS = Path('/opt/relay-station-backups')
PG = 'relay-station-postgres-1'

def run(args, data=None):
    return subprocess.check_output(args, input=data, stderr=subprocess.PIPE).decode().strip()

def pg(args, data=None):
    return run(['docker', 'exec', '-i', PG] + args, data)

def tree_bytes(path):
    return sum(p.stat().st_size for p in path.rglob('*') if p.is_file() and not p.is_symlink())

def size_bytes(value):
    match = re.match(r'^([0-9.]+)\s*([KMGT]?)B$',str(value).strip(),re.I)
    if not match: return 0
    return int(float(match.group(1))*1000**('KMGT'.find(match.group(2).upper())+1 if match.group(2) else 0))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--verify-backup', action='store_true', help='Restore newest custom dump to an isolated disposable database')
    args = parser.parse_args()
    sets = sorted([p for p in BACKUPS.glob('pre-*') if p.is_dir() and not p.is_symlink()], key=lambda p:p.stat().st_mtime, reverse=True)
    disk = shutil.disk_usage('/opt/relay-station')
    # Create one atomic daily dump before restoring it. Never silently consume
    # the last disk space; refusal leaves cleanup disabled and raises an alert.
    backup_error = False
    if args.verify_backup and disk.free > 2*1024**3:
        day = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')
        folder = BACKUPS / ('pre-storage-' + day)
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        dump = folder / 'database.dump'
        if not dump.exists():
            partial = folder / 'database.dump.partial'
            try:
                fd = os.open(str(partial), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'wb') as target:
                    subprocess.run(['docker','exec',PG,'pg_dump','-U','relay','-Fc','relay_station'],stdout=target,stderr=subprocess.PIPE,check=True)
                partial.replace(dump)
            except subprocess.CalledProcessError:
                backup_error = True
                if partial.exists(): partial.unlink()
    dumps = sorted([p for p in BACKUPS.rglob('*.dump') if p.is_file() and not p.is_symlink()], key=lambda p:p.stat().st_mtime, reverse=True)
    images = [json.loads(line) for line in run(['docker','image','ls','--format','json']).splitlines()]
    cache_bytes = 0
    try:
        rows = [json.loads(line) for line in run(['docker','system','df','--format','{{json .}}']).splitlines()]
        cache_bytes = sum(size_bytes(row.get('Size')) for row in rows if row.get('Type') == 'Build Cache')
    except subprocess.CalledProcessError:
        pass
    project = [i for i in images if i.get('Repository') == 'relay-station']
    running = set(run(['docker','ps','-aq']).splitlines())
    used_images = set()
    for cid in running:
        used_images.add(run(['docker','inspect','--format','{{.Image}}',cid]))
    protected = set(i['ID'] for i in project[:3])
    protected.update(i['ID'] for i in project if 'rollback' in i.get('Tag',''))
    metrics = {'diskUsedPercent':100*disk.used/disk.total, 'diskFreeBytes':disk.free, 'buildCacheBytes':cache_bytes,
               'backupBytes':tree_bytes(BACKUPS), 'backupError':backup_error, 'projectImages':len(project), 'backupVerified':False,
               'cleanupMode':'apply' if args.apply else 'dry-run', 'buildCachePolicy':'No isolated relay builder configured; shared cache skipped',
               'plannedBackupDeletes':[], 'plannedImageDeletes':[]}
    # A list check alone is insufficient: require a complete restore before cleanup.
    disk = shutil.disk_usage('/opt/relay-station')
    if args.verify_backup and dumps and time.time()-dumps[0].stat().st_mtime < 86400 and disk.free > max(dumps[0].stat().st_size*5, 2*1024**3):
        name = 'relay_backup_verify_' + str(os.getpid())
        target = '/tmp/' + name + '.dump'
        try:
            run(['docker','cp',str(dumps[0]),PG+':'+target])
            pg(['pg_restore','--list',target])
            pg(['createdb','-U','relay',name])
            pg(['pg_restore','-U','relay','--no-owner','--exit-on-error','-d',name,target])
            pg(['psql','-U','relay','-d',name,'-Atc','SELECT count(*) FROM users'])
            metrics['backupVerified'] = True
            metrics['verifiedBackup'] = dumps[0].parent.name
        except subprocess.CalledProcessError:
            metrics['backupError'] = True
        finally:
            pg(['dropdb','-U','relay','--if-exists',name])
            pg(['rm','-f',target])
    # Future builds can use an isolated named builder; never prune the shared cache.
    try:
        run(['docker','buildx','inspect','relay-station-cache'])
        metrics['buildCachePolicy'] = 'Isolated relay builder: retain seven days'
        if args.apply and metrics['backupVerified']:
            run(['docker','buildx','prune','--builder','relay-station-cache','--filter','until=168h','--force'])
    except subprocess.CalledProcessError:
        pass
    if metrics['backupVerified']:
        for path in sets[10:]:
            if time.time()-path.stat().st_mtime > 30*86400:
                metrics['plannedBackupDeletes'].append(path.name)
                if args.apply:
                    shutil.rmtree(str(path))
        # Inspect timestamps, IDs and tags; never remove images from another repository.
        for image in project:
            fullid = run(['docker','image','inspect','--format','{{.Id}}',image['ID']])
            created = run(['docker','image','inspect','--format','{{.Created}}',image['ID']])
            stamp = datetime.datetime.strptime(created[:19],'%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp()
            if image['ID'] in protected or fullid in used_images or time.time()-stamp <= 14*86400:
                continue
            ref = 'relay-station:' + image['Tag']
            metrics['plannedImageDeletes'].append(ref)
            if args.apply:
                run(['docker','image','rm',ref])
    metrics['backupBytes'] = tree_bytes(BACKUPS)
    # No credentials on the command line; psql uses the container's local socket.
    payload = json.dumps(metrics, separators=(',',':'))
    sql = "INSERT INTO operations_snapshots(id,metrics) VALUES('host','" + payload.replace("'","''") + "'::jsonb) ON CONFLICT(id) DO UPDATE SET metrics=EXCLUDED.metrics,checked_at=now();"
    pg(['psql','-U','relay','-d','relay_station','-v','ON_ERROR_STOP=1'],sql.encode())
    print(json.dumps(metrics, ensure_ascii=False))

if __name__ == '__main__':
    main()
