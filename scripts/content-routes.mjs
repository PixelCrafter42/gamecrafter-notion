export function contentPaths(items) {
  const routes=[];
  for (const item of items) {
    if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.modulePath || '') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id || '')) {
      throw new Error('生成内容路由时发现无效路径');
    }
    const path=item.modulePath+'/'+item.id;
    routes.push(path,path+'/',path+'/index.html');
  }
  return [...new Set(routes)];
}
