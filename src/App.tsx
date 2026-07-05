import { useState, useEffect } from 'react';
import { Search, UploadCloud, Images, FolderOpen, Loader2, Download, CheckSquare, Square, X, LogOut, Video, Trash2 } from 'lucide-react';
import { Photo, User } from './types';
import { Auth } from './components/Auth';

function formatBytes(bytes: number, decimals = 1) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);

  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState<'albums' | 'all'>('albums');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'largest' | 'smallest' | 'name-asc' | 'name-desc'>('newest');
  const [uploadProgress, setUploadProgress] = useState<{current: number, total: number} | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);

  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);
  
  const [editingAlbum, setEditingAlbum] = useState<string | null>(null);
  const [newAlbumName, setNewAlbumName] = useState<string>('');

  useEffect(() => {
    if (token) {
      fetchUserAndPhotos(token);
    } else {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const hasAnalyzingFiles = photos.some(p => p.theme === 'Wordt geanalyseerd...');
    if (hasAnalyzingFiles) {
      const interval = setInterval(() => {
        fetchUserAndPhotos(token, true);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [photos, token]);

  const fetchUserAndPhotos = async (currentToken: string, silent = false) => {
    try {
      if (!silent) setLoading(true);
      // Fetch user profile
      const userRes = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${currentToken}` }
      });
      if (!userRes.ok) throw new Error('Invalid token');
      const userData = await userRes.json();
      setUser(userData.user);

      // Fetch photos
      const photoRes = await fetch('/api/photos', {
        headers: { Authorization: `Bearer ${currentToken}` }
      });
      if (photoRes.ok) {
        const photoData = await photoRes.json();
        setPhotos(photoData);
      }
    } catch (err) {
      handleLogout();
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleLogin = (newToken: string, loggedInUser: User) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(loggedInUser);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setPhotos([]);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length === 0) return;

    setUploading(true);
    setUploadProgress({ current: 0, total: selectedFiles.length });
    
    let filesToUpload: File[] = [];

    // Check for zip files
    for (const file of selectedFiles) {
      if (file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip') {
        try {
          const JSZipModule = await import('jszip');
          const JSZip = JSZipModule.default || JSZipModule;
          const zip = new JSZip();
          await zip.loadAsync(file);
          
          for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
            if (!zipEntry.dir && !relativePath.startsWith('__MACOSX/') && !relativePath.split('/').pop()?.startsWith('.')) {
              const blob = await zipEntry.async('blob');
              
              // Guess mime type roughly based on extension
              let type = '';
              const ext = relativePath.split('.').pop()?.toLowerCase();
              if (['jpg', 'jpeg'].includes(ext!)) type = 'image/jpeg';
              else if (ext === 'png') type = 'image/png';
              else if (ext === 'gif') type = 'image/gif';
              else if (ext === 'mp4') type = 'video/mp4';
              else if (ext === 'pdf') type = 'application/pdf';
              else if (ext === 'txt') type = 'text/plain';
              
              const extractedFile = new File([blob], zipEntry.name.split('/').pop() || zipEntry.name, { type });
              filesToUpload.push(extractedFile);
            }
          }
        } catch (err) {
          console.error('Error extracting zip:', err);
          filesToUpload.push(file); // fallback to uploading the zip itself
        }
      } else {
        filesToUpload.push(file);
      }
    }

    setUploadProgress({ current: 0, total: filesToUpload.length });

    let uploadedCount = 0;
    const concurrencyLimit = 5;

    for (let i = 0; i < filesToUpload.length; i += concurrencyLimit) {
      const chunk = filesToUpload.slice(i, i + concurrencyLimit);
      await Promise.all(chunk.map(async (file) => {
        const formData = new FormData();
        formData.append('photo', file);

        try {
          const res = await fetch('/api/upload', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          });
          if (res.ok) {
            const newPhoto = await res.json();
            setPhotos((prev) => [...prev, newPhoto]);
          }
        } catch (err) {
          console.error('Failed to upload', err);
        }
        
        uploadedCount++;
        setUploadProgress(prev => prev ? { ...prev, current: uploadedCount, total: filesToUpload.length } : null);
      }));
    }
    
    setUploading(false);
    setUploadProgress(null);
    e.target.value = '';
  };

  const downloadPhotosAsZip = async (photosToDownload: Photo[], zipName: string) => {
    setDownloadingZip(true);
    try {
      const JSZipModule = await import('jszip');
      const JSZip = JSZipModule.default || JSZipModule;
      const { saveAs } = await import('file-saver');
      const zip = new JSZip();

      const fetchPromises = photosToDownload.map(async (photo) => {
        const response = await fetch(`/uploads/${photo.filename}`);
        const blob = await response.blob();
        zip.file(photo.originalName || photo.filename, blob);
      });

      await Promise.all(fetchPromises);
      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${zipName}.zip`);
    } catch (err) {
      console.error('Failed to create zip', err);
    } finally {
      setDownloadingZip(false);
      setSelectionMode(false);
      setSelectedPhotos(new Set());
    }
  };

  const togglePhotoSelection = (photoId: string) => {
    setSelectedPhotos(prev => {
      const newSet = new Set(prev);
      if (newSet.has(photoId)) {
        newSet.delete(photoId);
      } else {
        newSet.add(photoId);
      }
      return newSet;
    });
  };

  const handleRenameAlbum = async (oldName: string, newName: string) => {
    if (!newName.trim() || newName.trim() === oldName) {
      setEditingAlbum(null);
      return;
    }
    
    const trimmedNewName = newName.trim();
    
    setPhotos(prev => prev.map(p => p.theme === oldName ? { ...p, theme: trimmedNewName } : p));
    setEditingAlbum(null);
    if (selectedAlbum === oldName) setSelectedAlbum(trimmedNewName);

    try {
      const res = await fetch('/api/albums/rename', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ oldName, newName: trimmedNewName })
      });
      
      if (!res.ok) {
        fetchUserAndPhotos(token!, true);
      }
    } catch(err) {
      fetchUserAndPhotos(token!, true);
    }
  };

  const handleDeletePhoto = async (photoId: string) => {
    if (!confirm('Weet je zeker dat je dit bestand wilt verwijderen?')) return;
    
    try {
      const res = await fetch(`/api/photos/${photoId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setPhotos(prev => prev.filter(p => p.id !== photoId));
        if (selectedPhotos.has(photoId)) {
          setSelectedPhotos(prev => {
            const newSet = new Set(prev);
            newSet.delete(photoId);
            return newSet;
          });
        }
      }
    } catch (err) {
      console.error('Failed to delete photo', err);
    }
  };

  if (!token) {
    return <Auth onLogin={handleLogin} />;
  }

  const sortedPhotos = [...photos].sort((a, b) => {
    if (sortOrder === 'newest') return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
    if (sortOrder === 'oldest') return new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
    if (sortOrder === 'largest') return (b.size || 0) - (a.size || 0);
    if (sortOrder === 'smallest') return (a.size || 0) - (b.size || 0);
    if (sortOrder === 'name-asc') return a.originalName.localeCompare(b.originalName);
    if (sortOrder === 'name-desc') return b.originalName.localeCompare(a.originalName);
    return 0;
  });

  const filteredPhotos = sortedPhotos.filter((p) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      p.tags.some(tag => tag.toLowerCase().includes(query)) ||
      p.description.toLowerCase().includes(query) ||
      p.theme.toLowerCase().includes(query) ||
      p.originalName.toLowerCase().includes(query)
    );
  });

  const albums = Array.from(new Set(photos.map(p => p.theme)));

  const displayPhotos = selectedAlbum
    ? filteredPhotos.filter(p => p.theme === selectedAlbum)
    : filteredPhotos;

  const renderMedia = (photo: Photo, isCover = false, coverClassName = "") => {
    const isVideo = photo.mimeType?.startsWith('video/');
    const isImage = photo.mimeType?.startsWith('image/');
    const src = `/uploads/${photo.filename}`;

    if (isVideo) {
      return (
        <div className="relative w-full h-full bg-slate-900 group-hover:scale-105 transition-transform duration-700">
          <video src={src} className={`w-full h-full object-cover ${isCover ? coverClassName : ''}`} muted loop playsInline onMouseEnter={(e) => (e.target as HTMLVideoElement).play()} onMouseLeave={(e) => { const v = e.target as HTMLVideoElement; v.pause(); v.currentTime = 0; }} />
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-transparent transition-colors">
            <Video className="w-8 h-8 text-white/80 drop-shadow-md" />
          </div>
        </div>
      );
    }

    if (isImage) {
      return (
        <img 
          src={src} 
          alt={photo.description} 
          className={`w-full h-full object-cover transition-transform duration-700 ${isCover ? coverClassName : 'group-hover:scale-105'}`}
        />
      );
    }

    // Default icon for non-media files
    return (
      <div className={`w-full h-full flex flex-col items-center justify-center bg-slate-200 text-slate-400 transition-transform duration-700 ${isCover ? coverClassName : 'group-hover:scale-105'}`}>
        <FolderOpen className="w-12 h-12 mb-2 text-indigo-300" />
        <span className="text-xs font-semibold px-2 text-center break-words max-w-full truncate">{photo.originalName}</span>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans flex flex-col">
      <header className="h-20 bg-white border-b border-slate-200 px-4 md:px-8 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => { setView('albums'); setSelectedAlbum(null); }}>
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shrink-0">
            <div className="grid grid-cols-2 gap-1">
              <div className="w-2 h-2 bg-white rounded-full"></div>
              <div className="w-2 h-2 bg-indigo-300"></div>
              <div className="w-2 h-2 bg-indigo-300"></div>
              <div className="w-2 h-2 bg-white rounded-sm"></div>
            </div>
          </div>
          <span className="hidden lg:inline text-xl font-bold tracking-tight text-slate-800">Sorteer Je Bestanden</span>
        </div>
        
        <div className="flex-1 max-w-xl mx-4 sm:mx-8">
          <div className="relative">
            <div className="absolute left-4 top-3.5 opacity-40 pointer-events-none">
              <Search className="h-5 w-5 text-slate-800" />
            </div>
            <input
              type="text"
              className="w-full bg-slate-100 border-none rounded-xl py-3 pl-12 pr-4 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              placeholder="Zoek op trefwoorden..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 md:gap-6">
          <div className="hidden xl:flex items-center gap-2 mr-2">
            <div className="text-sm font-medium text-slate-600">{user?.name}</div>
          </div>
          <button
            onClick={handleLogout}
            title="Uitloggen"
            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto w-full max-w-7xl mx-auto">
        <div className="flex flex-col xl:flex-row justify-between items-start xl:items-end mb-8 gap-4">
          <div>
            <h2 className="text-3xl font-light text-slate-800 tracking-tight">
              {selectedAlbum ? selectedAlbum : view === 'albums' ? 'Automatische Albums' : 'Alle Bestanden'}
            </h2>
            <p className="text-slate-500 mt-1">Slim gesorteerd door AI</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3 w-full xl:w-auto">
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as any)}
              className="bg-white border border-slate-200 text-slate-600 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 shadow-sm outline-none cursor-pointer"
            >
              <option value="newest">Nieuwste eerst</option>
              <option value="oldest">Oudste eerst</option>
              <option value="largest">Grootste eerst</option>
              <option value="smallest">Kleinste eerst</option>
              <option value="name-asc">Naam (A-Z)</option>
              <option value="name-desc">Naam (Z-A)</option>
            </select>

            <button
              onClick={() => { setView('albums'); setSelectedAlbum(null); setSelectionMode(false); }}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors border ${view === 'albums' && !selectedAlbum ? 'bg-indigo-50 text-indigo-700 border-indigo-100' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm'}`}
            >
              Albums
            </button>
            <button
              onClick={() => { setView('all'); setSelectedAlbum(null); setSelectionMode(false); }}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors border ${view === 'all' ? 'bg-indigo-50 text-indigo-700 border-indigo-100' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm'}`}
            >
              Alle Bestanden
            </button>
            
            <div className="flex gap-2 shrink-0">
              <label className="cursor-pointer bg-indigo-600 text-white border border-transparent px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm hover:bg-indigo-700 transition-colors inline-flex items-center">
                {uploading ? <Loader2 className="animate-spin h-5 w-5 sm:mr-2" /> : <UploadCloud className="h-5 w-5 sm:mr-2" />}
                <span className="hidden sm:inline">
                  {uploading && uploadProgress ? `Uploaden (${uploadProgress.current}/${uploadProgress.total})...` : 'Uploaden'}
                </span>
                <input type="file" multiple className="hidden" onChange={handleFileUpload} disabled={uploading} />
              </label>
              <label className="cursor-pointer bg-white border border-slate-200 px-4 py-2.5 rounded-lg text-sm font-medium shadow-sm hover:bg-slate-50 transition-colors inline-flex items-center" title="Upload een hele map">
                <FolderOpen className="h-5 w-5 text-slate-500 sm:mr-2" />
                <span className="hidden sm:inline">Map</span>
                <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={handleFileUpload} disabled={uploading} />
              </label>
            </div>
            
            {selectedAlbum && (
              <div className="flex items-center text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-100 px-4 py-2.5 rounded-lg shadow-sm">
                <FolderOpen className="w-4 h-4 mr-2" />
                {selectedAlbum}
                <button onClick={() => { setSelectedAlbum(null); setSelectionMode(false); }} className="ml-2 text-indigo-400 hover:text-indigo-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            {(view === 'all' || selectedAlbum) && photos.length > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                {selectionMode && selectedPhotos.size > 0 && (
                  <button
                    onClick={() => downloadPhotosAsZip(photos.filter(p => selectedPhotos.has(p.id)), selectedAlbum || 'Geselecteerde_Fotos')}
                    disabled={downloadingZip}
                    className="flex items-center px-4 py-2.5 rounded-lg text-sm font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors shadow-sm disabled:opacity-50"
                  >
                    {downloadingZip ? <Loader2 className="animate-spin w-4 h-4 mr-2" /> : <Download className="w-4 h-4 mr-2" />}
                    Download ({selectedPhotos.size})
                  </button>
                )}
                <button
                  onClick={() => {
                    if (selectionMode) {
                      setSelectionMode(false);
                      setSelectedPhotos(new Set());
                    } else {
                      setSelectionMode(true);
                    }
                  }}
                  className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors border ${selectionMode ? 'bg-slate-100 text-slate-700 border-slate-200' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-sm'}`}
                >
                  {selectionMode ? 'Annuleren' : 'Selecteren'}
                </button>
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
          </div>
        ) : photos.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-3xl border border-slate-100 shadow-sm max-w-2xl mx-auto mt-12">
            <Images className="mx-auto h-12 w-12 text-slate-300" />
            <h3 className="mt-4 text-lg font-bold text-slate-800">Nog geen bestanden</h3>
            <p className="mt-1 text-sm text-slate-500">Upload je eerste bestanden of mappen om de AI zijn werk te laten doen en ze te groeperen in slimme mappen.</p>
          </div>
        ) : view === 'albums' && !selectedAlbum && !searchQuery ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {albums.map(album => {
              const albumPhotos = photos.filter(p => p.theme === album);
              const coverPhoto = albumPhotos[albumPhotos.length - 1]; // newest
              return (
                <div 
                  key={album} 
                  className="group cursor-pointer bg-white rounded-3xl p-6 shadow-sm border border-slate-100 flex flex-col justify-between hover:shadow-md transition-all duration-300 relative"
                  onClick={() => setSelectedAlbum(album)}
                >
                  <button
                    className="absolute top-8 right-8 z-10 bg-white/90 backdrop-blur-md text-slate-600 p-2 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-emerald-500 hover:text-white"
                    title="Download Album"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadPhotosAsZip(albumPhotos, album);
                    }}
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <div className="flex gap-2 h-40 mb-4">
                     <div className="flex-1 bg-slate-200 rounded-2xl overflow-hidden relative">
                       {coverPhoto ? (
                         renderMedia(coverPhoto, true, "group-hover:scale-105")
                       ) : (
                         <div className="w-full h-full flex items-center justify-center text-slate-300">
                           <FolderOpen className="w-8 h-8" />
                         </div>
                       )}
                       <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent"></div>
                     </div>
                  </div>
                  <div>
                    {editingAlbum === album ? (
                      <input
                        autoFocus
                        value={newAlbumName}
                        onChange={(e) => setNewAlbumName(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleRenameAlbum(album, newAlbumName);
                          } else if (e.key === 'Escape') {
                            setEditingAlbum(null);
                          }
                        }}
                        onBlur={() => handleRenameAlbum(album, newAlbumName)}
                        className="w-full text-lg font-bold text-slate-800 bg-slate-50 border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    ) : (
                      <h4 
                        className="text-lg font-bold text-slate-800 truncate hover:text-indigo-600 transition-colors"
                        title="Klik om te hernoemen"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingAlbum(album);
                          setNewAlbumName(album);
                        }}
                      >
                        {album}
                      </h4>
                    )}
                    <p className="text-sm text-slate-500">{albumPhotos.length} {albumPhotos.length === 1 ? 'bestand' : 'bestanden'}</p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {displayPhotos.map(photo => {
              const isSelected = selectedPhotos.has(photo.id);
              return (
              <div 
                key={photo.id} 
                className={`group bg-white rounded-3xl p-4 shadow-sm border flex flex-col gap-4 transition-all duration-300 ${selectionMode ? 'cursor-pointer' : ''} ${isSelected ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-100 hover:shadow-md'}`}
                onClick={() => {
                  if (selectionMode) {
                    togglePhotoSelection(photo.id);
                  }
                }}
              >
                <div className="w-full aspect-square bg-slate-100 rounded-2xl overflow-hidden relative">
                  {renderMedia(photo)}
                  
                  {selectionMode && (
                    <div className="absolute top-3 right-3 z-10">
                      {isSelected ? (
                        <div className="bg-indigo-500 text-white rounded-full p-1 shadow-sm">
                          <CheckSquare className="w-5 h-5" />
                        </div>
                      ) : (
                        <div className="bg-white/50 backdrop-blur-md text-slate-400 rounded-full p-1 shadow-sm border border-slate-200">
                          <Square className="w-5 h-5" />
                        </div>
                      )}
                    </div>
                  )}
                  {!selectionMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeletePhoto(photo.id);
                      }}
                      className="absolute top-3 right-3 z-10 bg-white/90 backdrop-blur-md text-slate-400 p-2 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 hover:text-white"
                      title="Verwijderen"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                  <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md text-slate-800 text-xs px-2.5 py-1 rounded-lg font-bold shadow-sm uppercase tracking-wide">
                    {photo.theme}
                  </div>
                </div>
                <div className="flex flex-col flex-1">
                  <p className="text-sm font-medium text-slate-800 line-clamp-2 mb-2">
                    {photo.description}
                  </p>
                  <div className="flex justify-between items-center text-[10px] text-slate-400 font-medium mb-3">
                    <span>{new Date(photo.uploadedAt).toLocaleDateString('nl-NL')}</span>
                    <span>{formatBytes(photo.size || 0)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-auto">
                    {photo.tags.slice(0, 3).map(tag => (
                      <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-500 uppercase tracking-wide">
                        {tag}
                      </span>
                    ))}
                    {photo.tags.length > 3 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-50 text-slate-400 uppercase tracking-wide">
                        +{photo.tags.length - 3}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
