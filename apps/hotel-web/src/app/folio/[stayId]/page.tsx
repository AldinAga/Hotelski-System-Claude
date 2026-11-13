import { FolioView } from '@/components/folio-view';

export default async function FolioPage({ params }: { params: Promise<{ stayId: string }> }) {
  const { stayId } = await params;
  return <FolioView stayId={stayId} />;
}
