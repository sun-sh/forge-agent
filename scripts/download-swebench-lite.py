"""Download a fixed public parquet and export a byte-reproducible JSONL, never credentials."""
import argparse
import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

REVISION = 'b0dde1093fe417d83b7184254edf8199c1f0dff5'
PARQUET_SHA256 = '438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3'
EXPORT_SHA256 = 'a7cab520e244f8fd23028324f2710a659870336eba87c7fd6713843636bb49ca'
URL = 'https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite/resolve/' + REVISION + '/data/test-00000-of-00001.parquet'

def export_file(parquet, target):
    import pyarrow
    import pyarrow.parquet as pq
    if pyarrow.__version__ != '26.0.1':
        raise RuntimeError('Use pyarrow==26.0.1 for this frozen export')
    if hashlib.sha256(Path(parquet).read_bytes()).hexdigest() != PARQUET_SHA256:
        raise RuntimeError('Downloaded parquet fingerprint mismatch')
    rows = pq.read_table(parquet).to_pylist()
    if len(rows) != 300:
        raise RuntimeError('Expected the complete 300-instance Lite test snapshot')
    with Path(target).open('w', encoding='utf-8', newline='\n') as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + '\n')
    actual = hashlib.sha256(Path(target).read_bytes()).hexdigest()
    if actual != EXPORT_SHA256:
        raise RuntimeError('JSONL export changed; retain this artifact and investigate rather than relabel the cohort')
    return {'dataset': 'SWE-bench/SWE-bench_Lite', 'revision': REVISION, 'parquetSha256': PARQUET_SHA256, 'exportSha256': actual, 'instances': len(rows), 'pyarrow': pyarrow.__version__}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--parquet', help='Use an already downloaded file, with the same checksum gate')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    parquet = output / 'test.parquet'
    if args.parquet:
        shutil.copyfile(args.parquet, parquet)
    else:
        with urllib.request.urlopen(URL, timeout=60) as response, parquet.open('wb') as target:
            total = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > 16000000:
                    raise RuntimeError('Unexpected dataset download size')
                target.write(chunk)
    identity = export_file(parquet, output / 'test.jsonl')
    (output / 'dataset-identity.json').write_text(json.dumps(identity, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(identity))

if __name__ == '__main__':
    main()
