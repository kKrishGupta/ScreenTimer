"""Read-only PE/ZIP inventory; no executable is launched or release modified."""
import hashlib
import json
import pathlib
import struct
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
out = root / 'artifacts/windows-exe-audit-20261108'

def inspect(data, name):
    result = dict(path=name, size=len(data), sha256=hashlib.sha256(data).hexdigest())
    try:
        pe = struct.unpack_from('<I', data, 0x3c)[0]
        assert data[pe:pe+4] == b'PE\0\0'
        machine, sections, timestamp = struct.unpack_from('<HHI', data, pe+4)
        optional_size = struct.unpack_from('<H', data, pe+20)[0]
        opt = pe+24
        magic = struct.unpack_from('<H', data, opt)[0]
        result.update(architecture={0x8664:'x64',0xaa64:'ARM64',0x14c:'x86'}.get(machine,hex(machine)), pe_timestamp=timestamp,
                      subsystem=struct.unpack_from('<H', data, opt+68)[0])
        table = opt+optional_size
        def offset(rva):
            for i in range(sections):
                s = table+i*40
                size, va, rawsize, raw = struct.unpack_from('<IIII', data, s+8)
                if va <= rva < va+max(size, rawsize):
                    return raw+rva-va
            raise ValueError('unmapped RVA')
        dirs = opt+(112 if magic == 0x20b else 96)
        imports_rva = struct.unpack_from('<I',data,dirs+8)[0]
        imports=[]
        if imports_rva:
            cursor=offset(imports_rva)
            while any(data[cursor:cursor+20]):
                nameoff=offset(struct.unpack_from('<I',data,cursor+12)[0])
                imports.append(data[nameoff:data.index(b'\0',nameoff)].decode('ascii'))
                cursor+=20
        result['imports']=imports
        result['certificate_table_bytes']=struct.unpack_from('<I',data,dirs+4*8+4)[0]
    except Exception as error:
        result['pe_error']=str(error)
    return result

rows=[]
for path in root.rglob('*'):
    if not path.is_file() or '.git' in path.parts:
        continue
    if path.suffix.lower()=='.exe':
        rows.append(inspect(path.read_bytes(), str(path.relative_to(root))))
    elif path.suffix.lower()=='.zip':
        try:
            with zipfile.ZipFile(path) as archive:
                for entry in archive.infolist():
                    if entry.filename.lower().endswith('.exe'):
                        rows.append(inspect(archive.read(entry),str(path.relative_to(root))+'!'+entry.filename))
        except zipfile.BadZipFile:
            pass
out.mkdir(parents=True,exist_ok=True)
dest=out / (sys.argv[1] if len(sys.argv)>1 else 'inventory.json')
dest.write_text(json.dumps(rows,indent=2),encoding='utf-8')
print(json.dumps({'artifacts':len(rows),'output':str(dest)}))
